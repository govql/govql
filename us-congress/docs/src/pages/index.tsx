import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';
const Svg = require('@site/static/img/govql-social-cleaned.svg').default;

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
          <Svg role="img" className="heroImage"/>
        <p className="hero__subtitle">{siteConfig.tagline}</p>

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
