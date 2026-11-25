import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Feed from '@site/src/components/Feed';

import styles from './index.module.css';
const Svg = require('@site/static/img/govql-social-cleaned.svg').default;

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  const [feedExpanded, setFeedExpanded] = useState(true);
  return (
    <header
      className={clsx(styles.heroBanner, !feedExpanded && styles.feedCollapsed)}
    >
      <div className={clsx('hero hero--primary', styles.heroTitle)}>
        <div className="container">
          <Svg role="img" className="heroImage"/>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
        </div>
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
      <h3 className={styles.subHeading}>
        Lots of government data is available, but that doesn't mean it's easy to
        access and extract insights from it. This project is an attempt to
        rectify that.
      </h3>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
