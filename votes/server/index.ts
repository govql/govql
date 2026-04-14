import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';
import mongoose from 'mongoose';
import { composeMongoose } from 'graphql-compose-mongoose';
import {
  schemaComposer,
  ResolverFilterArgConfigDefinition,
} from 'graphql-compose';
// import { EnvelopArmor } from '@escape.tech/graphql-armor';
import { useRateLimiter } from '@envelop/rate-limiter';
import {
  GraphQLDirective,
  DirectiveLocation,
  GraphQLInt,
  GraphQLString,
  GraphQLError,
  printSchema,
} from 'graphql';
// import { usePrometheus } from '@graphql-yoga/plugin-prometheus';
import { useOpenTelemetry } from '@envelop/opentelemetry';

const MONGO_URI = process.env.MONGO_URI ?? '';

// const armor = new EnvelopArmor();
// const protection = armor.protect();

const BillSchema = new mongoose.Schema(
  {
    congress: Number,
    number: Number,
    title: String,
    type: String,
  },
  { _id: false }
);
const CongressVoterSchema = new mongoose.Schema(
  {
    display_name: String,
    first_name: String,
    id: String,
    last_name: String,
    party: String,
    state: String,
  },
  { _id: false }
);
const VoteSchema = new mongoose.Schema(
  {
    Nay: { type: [CongressVoterSchema], default: [] },
    'Not Voting': {
      type: [CongressVoterSchema],
      default: [],
      alias: 'Not_Voting',
    },
    Present: { type: [CongressVoterSchema], default: [] },
    Yea: { type: [CongressVoterSchema], default: [] },
    Aye: { type: [CongressVoterSchema], default: [] },
    No: { type: [CongressVoterSchema], default: [] },
    Emmer: { type: [CongressVoterSchema], default: [] },
    Jeffries: { type: [CongressVoterSchema], default: [] },
    'Johnson (LA)': {
      type: [CongressVoterSchema],
      default: [],
      alias: 'Johnson_LA',
    },
  },
  { _id: false }
);
const AmendmentSchema = new mongoose.Schema(
  {
    number: Number,
    purpose: String,
    type: String,
  },
  { _id: false }
);
const NominationSchema = new mongoose.Schema(
  {
    number: String,
    title: String,
  },
  { _id: false }
);
const VoteContainerSchema = new mongoose.Schema({
  amendment: AmendmentSchema,
  bill: BillSchema,
  nomination: NominationSchema,
  category: String,
  chamber: String,
  congress: Number,
  date: String,
  number: Number,
  question: String,
  record_modified: String,
  requires: String,
  result: String,
  result_text: String,
  session: String,
  source_url: String,
  subject: String,
  type: String,
  updated_at: String,
  vote_id: String,
  votes: { type: [VoteSchema], default: [] },
});

const VoteContainer = mongoose.model('votes', VoteContainerSchema);

// TODO: figure out how to resolve the TS error without ignoring.
// @ts-expect-error Having issues with figuring out the right type here.
const VoteContainerTC = composeMongoose(VoteContainer);

// STEP 2.5: Create some filters
const votedYeaFilter: ResolverFilterArgConfigDefinition<
  typeof VoteSchema,
  string | string[]
> = {
  name: 'votedYea',
  type: 'String',
  description: 'Filter votes by yeas from a Congressperson',
  query: (query: any, value: any) => {
    query['votes.Yea.last_name'] = { $in: [value] };
  },
};
const votedNayFilter: ResolverFilterArgConfigDefinition<
  typeof VoteSchema,
  string | string[]
> = {
  name: 'votedNay',
  type: 'String',
  description: 'Filter votes by nays from a Congressperson',
  query: (query: any, value: any) => {
    query['votes.Nay.last_name'] = { $in: [value] };
  },
};

schemaComposer.Query.addFields({
  voteOne: VoteContainerTC.mongooseResolvers
    .findOne()
    .addFilterArg(votedYeaFilter)
    .addFilterArg(votedNayFilter),
  voteMany: VoteContainerTC.mongooseResolvers
    .findMany()
    .addFilterArg(votedYeaFilter)
    .addFilterArg(votedNayFilter),
  voteCount: VoteContainerTC.mongooseResolvers
    .count()
    .addFilterArg(votedYeaFilter)
    .addFilterArg(votedNayFilter),
});

const rateLimitDirective = new GraphQLDirective({
  name: 'rateLimit',
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    max: { type: GraphQLInt },
    window: { type: GraphQLString },
    message: { type: GraphQLString },
  },
});

schemaComposer.addDirective(rateLimitDirective);

schemaComposer.Query.setFieldDirectiveByName('voteOne', 'rateLimit', {
  max: 10,
  window: '30s',
});

schemaComposer.Query.setFieldDirectiveByName('voteMany', 'rateLimit', {
  max: 10,
  window: '30s',
});
schemaComposer.Query.setFieldDirectiveByName('voteCount', 'rateLimit', {
  max: 10,
  window: '30s',
});

export const schema = schemaComposer.buildSchema();

console.log(printSchema(schema));

const yoga = createYoga({
  schema,
  plugins: [
    // ...protection.plugins,
    useRateLimiter({
      identifyFn: (context: any) => context?.ip ?? null,
      onRateLimitError() {
        throw new GraphQLError(
          "You've been rate limited! Cool your heels and try again later."
        );
      },
    }),
    // usePrometheus({
    //   endpoint: '/metrics', // optional, default is `/metrics`, you can disable it by setting it to `false` if registry is configured in "push" mode
    //   // Optional, see default values below
    //   metrics: {
    //     // By default, these are the metrics that are enabled:
    //     graphql_envelop_request_time_summary: true,
    //     graphql_envelop_phase_parse: true,
    //     graphql_envelop_phase_validate: true,
    //     graphql_envelop_phase_context: true,
    //     graphql_envelop_phase_execute: true,
    //     graphql_envelop_phase_subscribe: true,
    //     graphql_envelop_error_result: true,
    //     graphql_envelop_deprecated_field: true,
    //     graphql_envelop_request_duration: true,
    //     graphql_envelop_schema_change: true,
    //     graphql_envelop_request: true,
    //     graphql_yoga_http_duration: true,

    //     // This metric is disabled by default.
    //     // Warning: enabling resolvers level metrics will introduce significant overhead
    //     graphql_envelop_execute_resolver: false,
    //   },
    // }),
    useOpenTelemetry({
      resolvers: true, // Tracks resolvers calls, and tracks resolvers thrown errors
      variables: true, // Includes the operation variables values as part of the metadata collected
      result: true, // Includes execution result object as part of the metadata collected
    }),
  ],
  context: ({ request }) => {
    const ip = request.headers.get('ip') ?? null;
    return { ip };
  },
  graphiql: {
    defaultQuery: `
query {
  voteMany(filter: {votedYea: "Durbin", votedNay: "Duckworth"}) {
    vote_id
    question
    result
    type
    date
  }
}
    `,
  },
});

void (async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
  }

  const server = createServer(yoga);

  server.listen(4000, () => {
    console.info('Server is running on http://localhost:4000/graphql');
  });
})();
