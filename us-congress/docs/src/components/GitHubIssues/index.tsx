import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface Label {
  id: number;
  name: string;
  color: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  labels: Label[];
  body: string | null;
  created_at: string;
  user: { login: string; html_url: string };
}

function labelTextColor(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Perceived luminance — dark bg gets white text
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000' : '#fff';
}

interface Props {
  org: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
}

export default function GitHubIssues({ org, repo, state = 'open' }: Props): ReactNode {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(
      `https://api.github.com/repos/${org}/${repo}/issues?state=${state}&per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } }
    )
      .then((res) => {
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        return res.json();
      })
      .then((data: Issue[]) => {
        // GitHub issues API returns PRs too — filter them out
        setIssues(data.filter((i) => !('pull_request' in i)));
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [org, repo, state]);

  if (loading) return <p>Loading issues…</p>;
  if (error) return <p>Failed to load issues: {error}</p>;
  if (issues.length === 0) return <p>No {state} issues found.</p>;

  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {issues.map((issue) => (
        <li
          key={issue.id}
          style={{
            borderBottom: '1px solid var(--ifm-color-emphasis-300)',
            padding: '0.75rem 0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
            <a href={issue.html_url} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
              {issue.title}
            </a>
            <span style={{ color: 'var(--ifm-color-emphasis-600)', fontSize: '0.8rem' }}>
              #{issue.number}
            </span>
            {issue.labels.map((label) => (
              <span
                key={label.id}
                style={{
                  backgroundColor: `#${label.color}`,
                  color: labelTextColor(label.color),
                  borderRadius: '2em',
                  padding: '0.1em 0.6em',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                }}
              >
                {label.name}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
