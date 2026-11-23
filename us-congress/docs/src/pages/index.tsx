import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Feed from '@site/src/components/Feed';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  const [feedExpanded, setFeedExpanded] = useState(true);
  return (
    <header
      className={clsx(styles.heroBanner, !feedExpanded && styles.feedCollapsed)}
    >
      <div className={clsx('hero hero--primary', styles.heroTitle)}>
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        {/* Fixed line break so the tagline doesn't reflow as the feed
            collapses and the title panel changes width. */}
        <p className="hero__subtitle">
          Making US Government Data
          <br />
          accessible via GraphQL
        </p>
      </div>
      <div className={styles.heroFeed}>
        <Feed onExpandedChange={setFeedExpanded} />
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title}`}
      description="Making US Government data accessible via GraphQL"
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
