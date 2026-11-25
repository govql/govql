import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Heading from '@theme/Heading';

const API_URL = 'https://api.govql.us/graphql';
// const API_URL = 'http://localhost:4000/graphql';

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

const FEED_QUERY = `
  query RecentlyUpdatedBills {
    allBillsList(
      filter: {
        createdAt: { lessThan: "2026-11-01" }
        updatedAt: { greaterThanOrEqualTo: "2026-11-01" }
      }
      orderBy: UPDATED_AT_DESC
      first: 5
    ) {
      billId
      title
      updatedAt
    }
  }
`;

interface FeedBill {
  billId: string;
  title: string | null;
  updatedAt: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateTitle(title: string | null): string {
  if (!title) return '—';
  return title.length > 66 ? `${title.slice(0, 63)}...` : title;
}

interface FeedProps {
  expanded: boolean;
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
};

export default function Feed({ expanded }: FeedProps): ReactNode {
  const [bills, setBills] = useState<FeedBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gql<{ allBillsList: FeedBill[] }>(FEED_QUERY)
      .then((data) => {
        setBills(data.allBillsList);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  let body: ReactNode;
  if (loading) {
    body = (
      <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>Loading bills…</p>
    );
  } else if (error) {
    body = <p style={{ color: 'red' }}>Failed to load bills: {error}</p>;
  } else if (bills.length === 0) {
    body = (
      <p style={{ color: 'var(--ifm-color-emphasis-600)' }}>
        No recently updated bills.
      </p>
    );
  } else {
    body = (
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
              <th style={thStyle}>Bill</th>
              <th style={{ ...thStyle, whiteSpace: 'normal' }}>Title</th>
              <th style={thStyle}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
              <tr
                key={bill.billId}
                style={{
                  borderBottom: '1px solid var(--ifm-color-emphasis-200)',
                }}
              >
                <td
                  style={{
                    ...tdStyle,
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--ifm-font-family-monospace)',
                  }}
                >
                  {bill.billId}
                </td>
                <td style={tdStyle} title={bill.title ?? undefined}>
                  {truncateTitle(bill.title)}
                </td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                  {formatDateTime(bill.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <Heading
          as="h2"
          style={{
            margin: 0,
            visibility: expanded ? 'visible' : 'hidden',
          }}
        >
          Recently Updated Bills
        </Heading>
      </div>
      <div
        id="feed-body"
        aria-hidden={!expanded}
        style={{ visibility: expanded ? 'visible' : 'hidden' }}
      >
        {body}
      </div>
    </div>
  );
}
