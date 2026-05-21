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

// Step 1: fetch all vote IDs for a congress + chamber
const VOTE_IDS_QUERY = `
  query VoteIds($congress: Int!, $chamber: String!) {
    allVotes(
      filter: {
        chamber: { equalTo: $chamber }
        congress: { equalTo: $congress }
      }
      first: 2000
    ) {
      nodes { voteId }
    }
  }
`;

// Step 2: fetch positions for a batch of vote IDs (flat, no nesting)
const POSITIONS_QUERY = `
  query Positions($ids: [String!]!) {
    allVotePositions(
      filter: { voteId: { in: $ids } }
      first: 30000
    ) {
      nodes {
        bioguideId
        voteId
        position
        party
        state
      }
    }
  }
`;

// Step 3: fetch legislator names by bioguide ID
const LEGISLATORS_QUERY = `
  query LegislatorNames($ids: [String!]!) {
    allLegislators(filter: { bioguideId: { in: $ids } }) {
      nodes {
        bioguideId
        firstName
        lastName
      }
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

interface FlatPosition {
  voteId: string;
  bioguideId: string;
  position: string;
  party: string | null;
  state: string | null;
}

interface LegislatorName {
  bioguideId: string;
  firstName: string;
  lastName: string;
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

const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 6;
const MIN_AGREEMENT = 0.5;
const MIN_SHARED_VOTES = 15;

async function fetchAllPositions(
  voteIds: string[],
  onProgress: (done: number, total: number) => void
): Promise<FlatPosition[]> {
  const batches: string[][] = [];
  for (let i = 0; i < voteIds.length; i += BATCH_SIZE) {
    batches.push(voteIds.slice(i, i + BATCH_SIZE));
  }

  const results: FlatPosition[] = [];
  let completed = 0;

  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map((ids) =>
        gql<{ allVotePositions: { nodes: FlatPosition[] } }>(
          POSITIONS_QUERY,
          { ids }
        ).then((d) => d.allVotePositions.nodes)
      )
    );
    for (const r of chunkResults) results.push(...r);
    completed += chunk.length;
    onProgress(completed, batches.length);
  }

  return results;
}

function buildGraph(
  positions: FlatPosition[],
  nameMap: Map<string, string>
): { nodes: GraphNode[]; links: GraphLink[] } {
  const memberVotes = new Map<string, Map<string, string>>();
  const memberInfo = new Map<
    string,
    { name: string; party: string; state: string }
  >();

  for (const pos of positions) {
    if (!pos.bioguideId) continue;
    const { position } = pos;
    if (
      position === 'VP' ||
      position === 'Not Voting' ||
      position === 'Present'
    )
      continue;

    if (!memberVotes.has(pos.bioguideId)) {
      memberVotes.set(pos.bioguideId, new Map());
      memberInfo.set(pos.bioguideId, {
        name: nameMap.get(pos.bioguideId) ?? pos.bioguideId,
        party: pos.party ?? 'Unknown',
        state: pos.state ?? '',
      });
    }
    memberVotes.get(pos.bioguideId)!.set(pos.voteId, position);
  }

  const members = Array.from(memberVotes.keys());

  const links: GraphLink[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const aVotes = memberVotes.get(members[i])!;
      const bVotes = memberVotes.get(members[j])!;
      let same = 0;
      let total = 0;
      for (const [voteId, posA] of aVotes) {
        if (bVotes.has(voteId)) {
          total++;
          if (bVotes.get(voteId) === posA) same++;
        }
      }
      if (total >= MIN_SHARED_VOTES) {
        const agreement = same / total;
        if (agreement >= MIN_AGREEMENT) {
          links.push({
            source: members[i],
            target: members[j],
            agreement,
            sharedVotes: total,
          });
        }
      }
    }
  }

  const nodes: GraphNode[] = members.map((id) => ({
    id,
    name: memberInfo.get(id)!.name,
    party: memberInfo.get(id)!.party,
    state: memberInfo.get(id)!.state,
    voteCount: memberVotes.get(id)!.size,
  }));

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
        // Step 1: get all vote IDs for this congress + chamber
        const voteData = await gql<{ allVotes: { nodes: { voteId: string }[] } }>(
          VOTE_IDS_QUERY,
          { congress: selectedCongress, chamber: selectedChamber }
        );
        if (cancelled) return;

        const voteIds = voteData.allVotes.nodes.map((n) => n.voteId);

        // Step 2: fetch positions in parallel batches
        const positions = await fetchAllPositions(voteIds, (done, total) => {
          if (!cancelled) setProgress({ done, total });
        });
        if (cancelled) return;

        // Step 3: fetch legislator names for the members we found
        const ids = Array.from(
          new Set(positions.map((p) => p.bioguideId).filter(Boolean))
        );
        const namesData = await gql<{
          allLegislators: { nodes: LegislatorName[] };
        }>(LEGISLATORS_QUERY, { ids });
        if (cancelled) return;

        const nameMap = new Map(
          namesData.allLegislators.nodes.map((l) => [
            l.bioguideId,
            `${l.firstName} ${l.lastName}`,
          ])
        );

        setGraphData(buildGraph(positions, nameMap));
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
          {progress
            ? `Fetching votes: ${progress.done} of ${progress.total} batches…`
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
