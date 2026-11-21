import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';


export default function QuickStart(): ReactNode {
  return (
    <Layout
      title="QuickStart"
      description="introduction to using govql"
    >
    <h1>Quick Start</h1>
    <h2>Composing a Query</h2>
    <p>
      GovQL data is exposed through 
      <pre><code>
          const query = `

          `
      </code></pre>
    </p>
    </Layout>
  );
}
