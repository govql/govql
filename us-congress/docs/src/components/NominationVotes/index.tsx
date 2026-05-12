import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const API_URL = 'https://api.govql.us/graphql';
// const API_URL = 'http://localhost:4000/graphql';

const US_STATES = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

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

const SESSIONS_QUERY = `
  query AvailableSessions {
    allVotes(
      filter: { chamber: { equalTo: "s" }, category: { equalTo: "nomination" } }
      first: 5000
    ) {
      nodes {
        congress
        session
      }
    }
  }
`;

function getNominationsQuery(withYear: boolean): string {
  return `
    query NominationVotes($congress: Int!, ${withYear ? '$session: String!, ' : ''}$state: String!) {
      allVotes(
        filter: {
          chamber: { equalTo: "s" }
          category: { equalTo: "nomination" }
          congress: { equalTo: $congress }
          ${withYear ? 'session: { equalTo: $session }' : ''}
        }
        orderBy: VOTED_AT_DESC
        first: 500
      ) {
        nodes {
          voteId
          question
          result
          votedAt
          sourceUrl
          votePositionsByVoteId(filter: { state: { equalTo: $state } }) {
            nodes {
              position
              bioguideId
              party
              legislatorByBioguideId {
                firstName
                lastName
                officialFull
              }
            }
          }
        }
      }
    }
  `;
}

interface SessionNode {
  congress: number;
  session: string;
}

interface LegislatorInfo {
  firstName: string;
  lastName: string;
  officialFull: string | null;
}

interface VotePosition {
  position: string;
  bioguideId: string;
  party: string | null;
  legislatorByBioguideId: LegislatorInfo | null;
}

interface NominationVote {
  voteId: string;
  question: string;
  result: string | null;
  votedAt: string | null;
  sourceUrl: string | null;
  votePositionsByVoteId: {
    nodes: VotePosition[];
  };
}

const POSITION_STYLES: Record<string, { background: string; color: string }> = {
  Yea: { background: '#d4edda', color: '#155724' },
  Nay: { background: '#f8d7da', color: '#721c24' },
  'Not Voting': { background: '#e2e3e5', color: '#383d41' },
  Present: { background: '#fff3cd', color: '#856404' },
};

function positionBadge(position: string | undefined) {
  const pos = position ?? '—';
  const style = POSITION_STYLES[pos] ?? {
    background: '#e2e3e5',
    color: '#383d41',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15em 0.65em',
        borderRadius: '2em',
        background: style.background,
        color: style.color,
        fontWeight: 600,
        fontSize: '0.8rem',
        whiteSpace: 'nowrap',
      }}
    >
      {pos}
    </span>
  );
}

function senatorLabel(pos: VotePosition): string {
  const name =
    (pos.legislatorByBioguideId?.officialFull ??
      `${pos.legislatorByBioguideId?.firstName ?? ''} ${pos.legislatorByBioguideId?.lastName ?? ''}`.trim()) ||
    pos.bioguideId;
  const party = pos.party ? ` (${pos.party})` : '';
  return `${name}${party}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const selectStyle: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  fontSize: '1rem',
  borderRadius: 4,
  border: '1px solid var(--ifm-color-emphasis-400)',
  background: 'var(--ifm-background-color)',
  color: 'var(--ifm-font-color-base)',
};

export default function NominationVotes(): ReactNode {
  const [sessionData, setSessionData] = useState<SessionNode[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [selectedCongress, setSelectedCongress] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedState, setSelectedState] = useState('');

  const [votes, setVotes] = useState<NominationVote[]>([]);
  const [votesLoading, setVotesLoading] = useState(false);
  const [votesError, setVotesError] = useState<string | null>(null);

  const congresses = Array.from(
    new Set(sessionData.map((s) => s.congress))
  ).sort((a, b) => b - a);

  const availableYears =
    selectedCongress !== null
      ? Array.from(
          new Set(
            sessionData
              .filter((s) => s.congress === selectedCongress)
              .map((s) => s.session)
          )
        ).sort((a, b) => b.localeCompare(a))
      : [];

  useEffect(() => {
    gql<{ allVotes: { nodes: SessionNode[] } }>(SESSIONS_QUERY)
      .then((data) => {
        const seen = new Set<string>();
        const unique = data.allVotes.nodes.filter(({ congress, session }) => {
          const key = `${congress}:${session}`;
          return seen.has(key) ? false : (seen.add(key), true);
        });
        setSessionData(unique);
        setSessionsLoading(false);
      })
      .catch((err: Error) => {
        setSessionsError(err.message);
        setSessionsLoading(false);
      });
  }, []);

  useEffect(() => {
    setSelectedYear('');
  }, [selectedCongress]);

  useEffect(() => {
    if (selectedCongress === null || !selectedState) {
      setVotes([]);
      return;
    }
    const variables: Record<string, unknown> = {
      congress: selectedCongress,
      state: selectedState,
    };
    if (selectedYear) variables.session = selectedYear;
    setVotesLoading(true);
    setVotesError(null);
    gql<{ allVotes: { nodes: NominationVote[] } }>(
      getNominationsQuery(!!selectedYear),
      variables
    )
      .then((data) => {
        setVotes(data.allVotes.nodes);
        setVotesLoading(false);
      })
      .catch((err: Error) => {
        setVotesError(err.message);
        setVotesLoading(false);
      });
  }, [selectedCongress, selectedYear, selectedState]);

  const senators =
    votes.length > 0
      ? Array.from(
          new Map(
            votes
              .flatMap((v) => v.votePositionsByVoteId.nodes)
              .map((p) => [p.bioguideId, p])
          ).values()
        )
      : [];

  const stateName = US_STATES.find((s) => s.code === selectedState)?.name;

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
            htmlFor="congress-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.35rem',
            }}
          >
            Congress
          </label>
          {sessionsLoading ? (
            <span style={{ color: 'var(--ifm-color-emphasis-600)' }}>
              Loading…
            </span>
          ) : sessionsError ? (
            <span style={{ color: 'red' }}>Error: {sessionsError}</span>
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

        <div>
          <label
            htmlFor="year-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.35rem',
            }}
          >
            Year{' '}
            <span
              style={{
                fontWeight: 400,
                color: 'var(--ifm-color-emphasis-600)',
              }}
            >
              (optional)
            </span>
          </label>
          <select
            id="year-select"
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            disabled={selectedCongress === null}
            style={selectStyle}
          >
            <option value="">All years</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="state-select"
            style={{
              display: 'block',
              fontWeight: 600,
              marginBottom: '0.35rem',
            }}
          >
            State
          </label>
          <select
            id="state-select"
            value={selectedState}
            onChange={(e) => setSelectedState(e.target.value)}
            style={selectStyle}
          >
            <option value="">— Select state —</option>
            {US_STATES.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {votesLoading && (
        <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>Loading votes…</p>
      )}

      {votesError && (
        <p style={{ color: 'red' }}>Failed to load votes: {votesError}</p>
      )}

      {!votesLoading &&
        !votesError &&
        selectedCongress !== null &&
        selectedState &&
        votes.length === 0 && (
          <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>
            No nomination votes found for this selection.
          </p>
        )}

      {!votesLoading && !votesError && votes.length > 0 && (
        <>
          <p
            style={{
              color: 'var(--ifm-color-emphasis-600)',
              fontSize: '0.875rem',
              marginBottom: '0.75rem',
            }}
          >
            {votes.length} nomination vote{votes.length !== 1 ? 's' : ''}
            {stateName ? ` — ${stateName} senators` : ''}
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.9rem',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '2px solid var(--ifm-color-emphasis-300)',
                  }}
                >
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      minWidth: 280,
                    }}
                  >
                    Nomination
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Result
                  </th>
                  {senators.map((s) => (
                    <th
                      key={s.bioguideId}
                      style={{
                        textAlign: 'center',
                        padding: '0.5rem 0.75rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {senatorLabel(s)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {votes.map((vote) => {
                  const posMap = new Map(
                    vote.votePositionsByVoteId.nodes.map((p) => [
                      p.bioguideId,
                      p,
                    ])
                  );
                  return (
                    <tr
                      key={vote.voteId}
                      style={{
                        borderBottom: '1px solid var(--ifm-color-emphasis-200)',
                      }}
                    >
                      <td style={{ padding: '0.5rem 0.75rem' }}>
                        {vote.sourceUrl ? (
                          <a
                            href={vote.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {vote.question || vote.voteId}
                          </a>
                        ) : (
                          vote.question || vote.voteId
                        )}
                      </td>
                      <td
                        style={{
                          padding: '0.5rem 0.75rem',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatDate(vote.votedAt)}
                      </td>
                      <td
                        style={{
                          padding: '0.5rem 0.75rem',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {vote.result ?? '—'}
                      </td>
                      {senators.map((s) => (
                        <td
                          key={s.bioguideId}
                          style={{
                            padding: '0.5rem 0.75rem',
                            textAlign: 'center',
                          }}
                        >
                          {positionBadge(posMap.get(s.bioguideId)?.position)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
