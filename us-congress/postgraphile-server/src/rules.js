import { GraphQLError, isNonNullType,isListType,isObjectType,isInterfaceType,isUnionType,getNamedType} from 'graphql';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('server');

// =============================================================================
// Depth limit
//
// Counts the deepest nesting level of a query, ignoring introspection fields
// (anything starting with __) entirely — they never touch the database so
// there is no cost concern, and their inherently deep ofType chains would
// otherwise trip the limit. The complexity budget below catches expensive
// real queries independently.
// =============================================================================
function maxDepthOfSelections(selections, fragments) {
  let max = 0;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name.value.startsWith('__')) continue;
      const child = sel.selectionSet
        ? 1 + maxDepthOfSelections(sel.selectionSet.selections, fragments)
        : 1;
      if (child > max) max = child;
    } else if (sel.kind === 'InlineFragment') {
      const child = maxDepthOfSelections(sel.selectionSet.selections, fragments);
      if (child > max) max = child;
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag) {
        const child = maxDepthOfSelections(frag.selectionSet.selections, fragments);
        if (child > max) max = child;
      }
    }
  }
  return max;
}

function depthLimitRule(maxDepth) {
  return function DepthLimitRule(context) {
    return {
      Document: {
        leave(node) {
          const fragments = {};
          const operations = [];
          for (const def of node.definitions) {
            if (def.kind === 'FragmentDefinition')
              fragments[def.name.value] = def;
            else if (def.kind === 'OperationDefinition') operations.push(def);
          }
          tracer.startActiveSpan('server.query.calculate_depth', (span) => {
            for (const op of operations) {
              const depth = maxDepthOfSelections(
                op.selectionSet.selections,
                fragments,
              );
              span.setAttribute('query.depth', depth);
              if (depth > maxDepth) {
                span.addEvent('query.depth_limit_exceeded');
                context.reportError(
                  new GraphQLError(
                    `Query depth ${depth} exceeds the limit of ${maxDepth}. ` +
                      'Use fewer levels of nesting.',
                  ),
                );
              }
            }
            span.end();
          });
        },
      },
    };
  };
}

// =============================================================================
// Complexity estimator
//
// Uses first/last as a multiplier so that:
//   votes(first: 100) { ... }                   → 100 × child cost
//   votes(first: 10) { votePositions(first: 50) } → 10 × 50 × child cost
//
// Unbounded list fields fall back to an assumed page size of 100.
// Budget: 10,000.
// =============================================================================
function postgraphileEstimator({ field, args, childComplexity }) {
  if (!field) return 1 + childComplexity;

  const limit = args.first ?? args.last;
  if (limit != null) return 1 + limit * Math.max(childComplexity, 1);

  const baseType = isNonNullType(field.type) ? field.type.ofType : field.type;
  if (
    isListType(baseType) ||
    getNamedType(field.type).name.endsWith('Connection')
  ) {
    return 1 + 100 * Math.max(childComplexity, 1);
  }

  return 1 + childComplexity;
}

function sumComplexity(selections, parentType, fragments, estimator) {
  let total = 0;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name.value.startsWith('__')) continue;

      const fieldDef =
        parentType && (isObjectType(parentType) || isInterfaceType(parentType))
          ? parentType.getFields()[sel.name.value]
          : null;

      const namedReturnType = fieldDef ? getNamedType(fieldDef.type) : null;
      const childType =
        namedReturnType &&
        (isObjectType(namedReturnType) ||
          isInterfaceType(namedReturnType) ||
          isUnionType(namedReturnType))
          ? namedReturnType
          : null;

      const childComplexity = sel.selectionSet
        ? sumComplexity(
            sel.selectionSet.selections,
            childType,
            fragments,
            estimator
          )
        : 0;

      const args = {};
      for (const arg of sel.arguments ?? []) {
        if (arg.value.kind === 'IntValue')
          args[arg.name.value] = parseInt(arg.value.value, 10);
      }

      total += estimator({ field: fieldDef, args, childComplexity }) ?? 1;
    } else if (sel.kind === 'InlineFragment') {
      total += sumComplexity(
        sel.selectionSet.selections,
        parentType,
        fragments,
        estimator
      );
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag)
        total += sumComplexity(
          frag.selectionSet.selections,
          parentType,
          fragments,
          estimator
        );
    }
  }
  return total;
}

function complexityLimitRule(maxComplexity, estimator) {
  return function ComplexityLimitRule(context) {
    return {
      Document: {
        leave(node) {
          const fragments = {};
          const operations = [];
          for (const def of node.definitions) {
            if (def.kind === 'FragmentDefinition')
              fragments[def.name.value] = def;
            else if (def.kind === 'OperationDefinition') operations.push(def);
          }

          const schema = context.getSchema();
          tracer.startActiveSpan('server.query.calculate_complexity', (span) => {
            for (const op of operations) {
              const rootType =
                op.operation === 'mutation'
                  ? schema.getMutationType()
                  : op.operation === 'subscription'
                    ? schema.getSubscriptionType()
                    : schema.getQueryType();

              const complexity = sumComplexity(
                op.selectionSet.selections,
                rootType,
                fragments,
                estimator
              );

              span.setAttribute('query.complexity', complexity);
              if (complexity > maxComplexity) {
                span.addEvent('query.complexity_limit_exceeded');
                context.reportError(
                  new GraphQLError(
                    `Query complexity ${complexity} exceeds the limit of ${maxComplexity}. ` +
                      'Use smaller page sizes or fewer nested fields.'
                  )
                );
              }
              span.end();
            }
            });
        },
      },
    };
  };
}

// =============================================================================
// Grafserv plugin: inject custom validation rules
//
// grafserv builds its `dynamicOptions.validationRules` array during `setPreset`
// and passes that array to graphql-js `validate()` on every request.  Plugins
// can intercept `setPreset` via `grafserv.middleware` to append extra rules.
// =============================================================================
export const validationRulesPlugin = {
  name: 'CustomValidationRules',
  grafserv: {
    middleware: {
      setPreset(next, event) {
        event.validationRules = [
          ...event.validationRules,
          // Hard depth cap — cheap check that runs before complexity counting.
          // Introspection fields (__schema, __type, …) are excluded; see the
          // depthLimitRule implementation above for the reasoning.
          depthLimitRule(10),
          // Per-operation complexity budget.
          complexityLimitRule(10_000_000_000, postgraphileEstimator),
        ];
        return next();
      },
    },
  },
};
