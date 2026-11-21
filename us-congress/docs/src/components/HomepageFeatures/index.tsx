import type { ReactNode } from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';
import Link from '@docusaurus/Link';
type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
  link: string;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Quick Start',
    Svg: require('@site/static/img/rocket.svg').default,
    description: (
      <>

      </>
    ),
    link: 'docs/quick-start',
  },
    {
    title: 'API Reference',
    Svg: require('@site/static/img/book.svg').default,
    description: (
      <>

      </>
    ),
     link: 'docs/schema',
  },
    {
    title: 'Try Queries',
    Svg: require('@site/static/img/play.svg').default,
    description: (
      <>

      </>
    ),
     link: 'http://api.govql.us/graphql',
  },
];

function Feature({ title, Svg, description, link }: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className={styles.featureCard}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
          <Link to={link}><Heading as="h3">{title}</Heading>   </Link>
          <p>{description}</p>
      </div>
      </div>
    </div>

  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
