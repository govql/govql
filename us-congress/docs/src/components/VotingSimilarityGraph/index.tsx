import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as d3 from 'd3';

const API_URL = 'https://api.govql.us/graphql';

function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

// Edges: precomputed pairwise agreement for a congress + chamber, paginated. Only pairs
// with enough shared votes are fetched server-side; the agreement ratio is thresholded
// client-side (vote_similarity has no agreement_rate column).
const SIMILARITY_QUERY = `
  query Sim($congress: Int!, $chamber: String!, $after: Cursor) {
    allVoteSimilarities(
      filter: {
        congress: { equalTo: $congress }
        chamber: { equalTo: $chamber }
        sharedVotes: { greaterThanOrEqualTo: 15 }
      }
      first: 10000
      after: $after
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { memberA memberB sharedVotes agreed }
    }
  }
`;

// Per-member party + name for the congress + chamber. One row per (member, other party);
// member_party is constant across a member's rows, so we keep the first per member.
const MEMBER_PARTY_QUERY = `
  query MemberParty($congress: Int!, $chamber: String!) {
    allMemberPartyAgreements(
      filter: {
        congress: { equalTo: $congress }
        chamber: { equalTo: $chamber }
      }
      first: 10000
    ) {
      nodes {
        bioguideId
        memberParty
        legislatorByBioguideId { firstName lastName }
      }
    }
  }
`;

// State (tooltip only): sample a few votes; their positions carry each member's state at
// vote time. A handful of votes covers essentially everyone who voted that congress.
const STATE_SAMPLE_QUERY = `
  query StateSample($congress: Int!, $chamber: String!) {
    allVotes(
      filter: {
        congress: { equalTo: $congress }
        chamber: { equalTo: $chamber }
      }
      first: 8
    ) {
      nodes {
        votePositionsByVoteIdList { bioguideId state }
      }
    }
  }
`;

// Per-member vote count (node size): sum of Yea/Nay positions across categories that congress.
const VOTE_COUNT_QUERY = `
  query VoteCounts($congress: Int!) {
    allMemberVotingSummaries(
      filter: {
        congress: { equalTo: $congress }
        position: { in: ["Yea", "Nay"] }
      }
      first: 20000
    ) {
      nodes { bioguideId positions }
    }
  }
`;

const CONGRESSES_QUERY = `
  query CongressList {
    allVotes(first: 10000) {
      nodes { congress }
    }
  }
`;

interface CongressNode {
  congress: number;
}

interface SimRow {
  memberA: string;
  memberB: string;
  sharedVotes: number;
  agreed: number;
}

interface MemberPartyRow {
  bioguideId: string;
  memberParty: string | null;
  legislatorByBioguideId: { firstName: string; lastName: string } | null;
}

interface StatePosition {
  bioguideId: string;
  state: string | null;
}

interface VoteCountRow {
  bioguideId: string;
  positions: number;
}

interface SimPage {
  allVoteSimilarities: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: SimRow[];
  };
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  name: string;
  party: string;
  state: string;
  voteCount: number;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  agreement: number;
  sharedVotes: number;
}

const MIN_AGREEMENT = 0.5;
const MIN_SHARED_VOTES = 15;

// Fetch every precomputed similarity pair for the congress + chamber, paging through the
// connection. Large pages keep the request count low (well under the per-IP rate limit).
async function fetchAllSimilarities(
  congress: number,
  chamber: string,
  onProgress: (pages: number) => void
): Promise<SimRow[]> {
  const rows: SimRow[] = [];
  let after: string | null = null;
  let pages = 0;

  for (;;) {
    const data: SimPage = await gql<SimPage>(SIMILARITY_QUERY, {
      congress,
      chamber,
      after,
    });

    rows.push(...data.allVoteSimilarities.nodes);
    pages += 1;
    onProgress(pages);

    const { hasNextPage, endCursor } = data.allVoteSimilarities.pageInfo;
    if (!hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return rows;
}

function buildGraph(
  simRows: SimRow[],
  partyNameMap: Map<string, { party: string; name: string }>,
  stateMap: Map<string, string>,
  voteCountMap: Map<string, number>
): { nodes: GraphNode[]; links: GraphLink[] } {
  // Nodes: every member in the congress/chamber (from member_party_agreement) — matches
  // the old behavior where every voting member is a node, even isolated ones.
  const nodes: GraphNode[] = Array.from(partyNameMap.entries()).map(
    ([id, info]) => ({
      id,
      name: info.name,
      party: info.party,
      state: stateMap.get(id) ?? '',
      voteCount: voteCountMap.get(id) ?? 0,
    })
  );
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Links: precomputed pairs. shared_votes >= MIN_SHARED_VOTES is enforced server-side; the
  // agreement ratio (agreed / shared_votes) is thresholded here. Skip any pair whose
  // endpoints aren't in the node set — d3.forceLink throws on a link to an unknown node.
  const links: GraphLink[] = [];
  for (const row of simRows) {
    if (row.sharedVotes < MIN_SHARED_VOTES) continue;
    const agreement = row.agreed / row.sharedVotes;
    if (agreement < MIN_AGREEMENT) continue;
    if (!nodeIds.has(row.memberA) || !nodeIds.has(row.memberB)) continue;
    links.push({
      source: row.memberA,
      target: row.memberB,
      agreement,
      sharedVotes: row.sharedVotes,
    });
  }

  return { nodes, links };
}

function partyColor(party: string): string {
  const p = party.toUpperCase();
  if (p === 'D' || p === 'DEMOCRAT' || p === 'DEMOCRATIC') return '#3B82F6';
  if (p === 'R' || p === 'REPUBLICAN') return '#EF4444';
  return '#A855F7';
}

const selectStyle: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  fontSize: '1rem',
  borderRadius: 4,
  border: '1px solid var(--ifm-color-emphasis-400)',
  background: 'var(--ifm-background-color)',
  color: 'var(--ifm-font-color-base)',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LinkSelection = d3.Selection<SVGLineElement, GraphLink, any, unknown>;

function ForceGraph({
  allNodes,
  allLinks,
}: {
  allNodes: GraphNode[];
  allLinks: GraphLink[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [threshold, setThreshold] = useState(0.9);
  const linkSelRef = useRef<LinkSelection | null>(null);

  useEffect(() => {
    if (!svgRef.current || !tooltipRef.current || allNodes.length === 0)
      return;

    const width = svgRef.current.clientWidth || 800;
    const height = 600;

    const nodes: GraphNode[] = allNodes.map((n) => ({ ...n }));
    const linksData: GraphLink[] = allLinks.map((l) => ({ ...l }));

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    linkSelRef.current = null;

    const tooltip = d3.select(tooltipRef.current);

    const g = svg.append('g');
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 4])
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
          g.attr('transform', event.transform.toString());
        })
    );

    const maxVotes = d3.max(nodes, (d) => d.voteCount) ?? 100;
    const rScale = d3.scaleSqrt().domain([0, maxVotes]).range([4, 12]);

    const linkGroup = g.append('g').attr('class', 'links');
    const link = linkGroup
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(linksData)
      .join('line')
      .attr('stroke', '#888')
      .attr('stroke-opacity', 0)
      .attr('stroke-width', (d) => Math.max(0.3, (d.agreement - 0.5) * 5));

    linkSelRef.current = link as LinkSelection;

    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', (d) => rScale(d.voteCount))
      .attr('fill', (d) => partyColor(d.party))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .style('cursor', 'grab')
      .call(
        d3
          .drag<SVGCircleElement, GraphNode>()
          .on(
            'start',
            (
              event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>,
              d
            ) => {
              if (!event.active) simulation.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
            }
          )
          .on(
            'drag',
            (
              event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>,
              d
            ) => {
              d.fx = event.x;
              d.fy = event.y;
            }
          )
          .on(
            'end',
            (
              event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>,
              d
            ) => {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null;
              d.fy = null;
            }
          )
      )
      .on('mouseenter', (_event: MouseEvent, d: GraphNode) => {
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${d.name}</strong><br/>` +
              `${d.party} &middot; ${d.state}<br/>` +
              `${d.voteCount} votes cast`
          );
      })
      .on('mousemove', (event: MouseEvent) => {
        const containerRect =
          svgRef.current!.parentElement!.getBoundingClientRect();
        tooltip
          .style('left', `${event.clientX - containerRect.left + 14}px`)
          .style('top', `${event.clientY - containerRect.top - 12}px`);
      })
      .on('mouseleave', () => tooltip.style('opacity', 0));

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(linksData)
          .id((d) => d.id)
          .distance((d) => 25 + (1 - d.agreement) * 70)
          .strength((d) => 0.05 + d.agreement * 0.2)
      )
      .force('charge', d3.forceManyBody<GraphNode>().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collision',
        d3.forceCollide<GraphNode>().radius((d) => rScale(d.voteCount) + 2)
      )
      .on('tick', () => {
        link
          .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
          .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
          .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
          .attr('y2', (d) => (d.target as GraphNode).y ?? 0);
        node.attr('cx', (d) => d.x ?? 0).attr('cy', (d) => d.y ?? 0);
      });

    return () => {
      simulation.stop();
      linkSelRef.current = null;
    };
  }, [allNodes, allLinks]);

  // Update link visibility when threshold changes without restarting simulation
  useEffect(() => {
    if (!linkSelRef.current) return;
    linkSelRef.current.attr('stroke-opacity', (d: GraphLink) =>
      d.agreement >= threshold ? 0.1 + d.agreement * 0.5 : 0
    );
  }, [threshold]);

  const aboveThreshold = allLinks.filter((l) => l.agreement >= threshold).length;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <label style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          Show edges above:
        </label>
        <input
          type="range"
          min={50}
          max={100}
          value={Math.round(threshold * 100)}
          onChange={(e) => setThreshold(Number(e.target.value) / 100)}
          style={{ width: 160 }}
        />
        <span style={{ fontWeight: 700, minWidth: 38 }}>
          {Math.round(threshold * 100)}%
        </span>
        <span
          style={{
            color: 'var(--ifm-color-emphasis-600)',
            fontSize: '0.85rem',
          }}
        >
          agreement &mdash; {aboveThreshold.toLocaleString()} edges visible
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '1.5rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          fontSize: '0.85rem',
          marginBottom: '0.75rem',
        }}
      >
        {(
          [
            ['#3B82F6', 'Democrat (D)'],
            ['#EF4444', 'Republican (R)'],
            ['#A855F7', 'Independent'],
          ] as [string, string][]
        ).map(([color, label]) => (
          <span
            key={label}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: color,
              }}
            />
            {label}
          </span>
        ))}
        <span style={{ color: 'var(--ifm-color-emphasis-600)' }}>
          Node size = votes cast &middot; Drag to reposition &middot; Scroll to
          zoom
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          style={{
            width: '100%',
            height: 600,
            border: '1px solid var(--ifm-color-emphasis-200)',
            borderRadius: 8,
          }}
        />
        <div
          ref={tooltipRef}
          style={{
            position: 'absolute',
            opacity: 0,
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: '0.8rem',
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            zIndex: 100,
          }}
        />
      </div>
    </div>
  );
}

export default function VotingSimilarityGraph(): ReactNode {
  const [congresses, setCongresses] = useState<number[]>([]);
  const [congressesLoading, setCongressesLoading] = useState(true);
  const [congressesError, setCongressesError] = useState<string | null>(null);

  const [selectedChamber, setSelectedChamber] = useState<'s' | 'h'>('s');
  const [selectedCongress, setSelectedCongress] = useState<number | null>(null);

  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  } | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    gql<{ allVotes: { nodes: CongressNode[] } }>(CONGRESSES_QUERY)
      .then((data) => {
        const unique = Array.from(
          new Set(data.allVotes.nodes.map((n) => n.congress))
        ).sort((a, b) => b - a);
        setCongresses(unique);
        setCongressesLoading(false);
      })
      .catch((err: Error) => {
        setCongressesError(err.message);
        setCongressesLoading(false);
      });
  }, []);

  useEffect(() => {
    setGraphData(null);
  }, [selectedChamber, selectedCongress]);

  useEffect(() => {
    if (selectedCongress === null) return;

    let cancelled = false;
    setDataLoading(true);
    setDataError(null);
    setProgress(null);

    (async () => {
      try {
        if (selectedCongress === null) return; // narrow for TS; outer guard already returned
        const congress = selectedCongress;
        const chamber = selectedChamber;

        // Four small, independent fetches in parallel: edges (paged), party+name, state
        // sample, and vote counts. The edge fetch dominates; the rest overlap it.
        const [simRows, memberPartyData, stateData, voteCountData] =
          await Promise.all([
            fetchAllSimilarities(congress, chamber, (pages) => {
              if (!cancelled) setProgress({ done: pages, total: 0 });
            }),
            gql<{ allMemberPartyAgreements: { nodes: MemberPartyRow[] } }>(
              MEMBER_PARTY_QUERY,
              { congress, chamber }
            ),
            gql<{
              allVotes: { nodes: { votePositionsByVoteIdList: StatePosition[] }[] };
            }>(STATE_SAMPLE_QUERY, { congress, chamber }),
            gql<{ allMemberVotingSummaries: { nodes: VoteCountRow[] } }>(
              VOTE_COUNT_QUERY,
              { congress }
            ),
          ]);
        if (cancelled) return;

        // Party + name, one entry per member (first row wins; party-switchers are rare).
        const partyNameMap = new Map<string, { party: string; name: string }>();
        for (const row of memberPartyData.allMemberPartyAgreements.nodes) {
          if (!row.bioguideId || partyNameMap.has(row.bioguideId)) continue;
          const leg = row.legislatorByBioguideId;
          partyNameMap.set(row.bioguideId, {
            party: row.memberParty ?? 'Unknown',
            name: leg ? `${leg.firstName} ${leg.lastName}` : row.bioguideId,
          });
        }

        // State at vote time, from the sampled votes' positions.
        const stateMap = new Map<string, string>();
        for (const vote of stateData.allVotes.nodes) {
          for (const pos of vote.votePositionsByVoteIdList ?? []) {
            if (pos.bioguideId && pos.state && !stateMap.has(pos.bioguideId)) {
              stateMap.set(pos.bioguideId, pos.state);
            }
          }
        }

        // Vote count = sum of Yea/Nay positions across categories.
        const voteCountMap = new Map<string, number>();
        for (const row of voteCountData.allMemberVotingSummaries.nodes) {
          if (!row.bioguideId) continue;
          voteCountMap.set(
            row.bioguideId,
            (voteCountMap.get(row.bioguideId) ?? 0) + (row.positions ?? 0)
          );
        }

        setGraphData(buildGraph(simRows, partyNameMap, stateMap, voteCountMap));
        setDataLoading(false);
        setProgress(null);
      } catch (err) {
        if (!cancelled) {
          setDataError((err as Error).message);
          setDataLoading(false);
          setProgress(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedCongress, selectedChamber]);

  const memberLabel = selectedChamber === 's' ? 'senators' : 'representatives';

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '1.5rem',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: '2rem',
        }}
      >
        <div>
          <label
            htmlFor="chamber-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.35rem',
            }}
          >
            Chamber
          </label>
          <select
            id="chamber-select"
            value={selectedChamber}
            onChange={(e) => setSelectedChamber(e.target.value as 's' | 'h')}
            style={selectStyle}
          >
            <option value="s">Senate</option>
            <option value="h">House</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="congress-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.35rem',
            }}
          >
            Congress
          </label>
          {congressesLoading ? (
            <span style={{ color: 'var(--ifm-color-emphasis-600)' }}>
              Loading…
            </span>
          ) : congressesError ? (
            <span style={{ color: 'red' }}>Error: {congressesError}</span>
          ) : (
            <select
              id="congress-select"
              value={selectedCongress ?? ''}
              onChange={(e) =>
                setSelectedCongress(
                  e.target.value ? Number(e.target.value) : null
                )
              }
              style={selectStyle}
            >
              <option value="">— Select congress —</option>
              {congresses.map((c) => (
                <option key={c} value={c}>
                  {ordinalSuffix(c)} Congress
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {dataLoading && (
        <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>
          {progress && progress.done > 0
            ? `Loading pairings… (page ${progress.done})`
            : 'Loading…'}
        </p>
      )}

      {dataError && <p style={{ color: 'red' }}>Error: {dataError}</p>}

      {!dataLoading && !dataError && graphData && (
        <>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--ifm-color-emphasis-600)',
              marginBottom: '0.75rem',
            }}
          >
            {graphData.nodes.length} {memberLabel} &middot;{' '}
            {graphData.links.length.toLocaleString()} pairings computed
            (agreement &ge; 50%)
          </p>
          <ForceGraph allNodes={graphData.nodes} allLinks={graphData.links} />
        </>
      )}
    </div>
  );
}
