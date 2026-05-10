import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import GitHubIssues from '@site/src/components/GitHubIssues';

export default function Roadmap(): ReactNode {
  return (
    <Layout
      title="Roadmap"
      description="Open issues and planned work for GovQL"
    >
      <div className="container margin-vert--lg">
        <Heading as="h1">Issues</Heading>
        <p>
          Tracked as GitHub issues in{' '}
          <a
            href="https://github.com/govql/govql"
            target="_blank"
            rel="noreferrer"
          >
            govql/govql
          </a>
          . Have an idea or found a bug?{' '}
          <a
            href="https://github.com/govql/govql/issues/new"
            target="_blank"
            rel="noreferrer"
          >
            Open an issue.
          </a>
        </p>
        <GitHubIssues org="govql" repo="govql" state="open" />
      </div>
    </Layout>
  );
}
