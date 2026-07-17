---
sidebar_label: Overview
sidebar_position: 1
---

# GraphQL API Reference

GovQL exposes all data through a [PostGraphile](https://postgraphile.org/)-generated GraphQL API at `https://api.govql.us/graphql`.

PostGraphile reflects the PostgreSQL schema directly into GraphQL — tables become types, columns become fields, and foreign keys become nested resolvers. The schema below is the complete public API surface.

:::tip
Try queries live in the built-in GraphiQL interface at **[api.govql.us/graphql](https://api.govql.us/graphql)**.
:::

## Data model

```
Legislators ──< LegislatorTerms
Legislators ──< VotePositions >── Votes ──< VotePositions
Legislators ──< BillCosponsors >── Bills >── Votes
Bills ──< BillCommittees >── Committees ──< CommitteeMemberships >── Legislators
```

## Available types

| Type | `allXxx` query | Description |
|------|----------------|-------------|
| [Legislator](./tables/legislators) | `allLegislators` | Every person who has served in Congress |
| [LegislatorTerm](./tables/legislator-terms) | `allLegislatorTerms` | Individual terms of service per chamber/state |
| [Vote](./tables/votes) | `allVotes` | Roll call vote events (House and Senate) |
| [VotePosition](./tables/vote-positions) | `allVotePositions` | Individual member Yea/Nay positions per vote |
| [Bill](./tables/bills) | `allBills` | Legislation referenced by roll call votes |
| [Committee](./tables/committees) | `allCommittees` | House, Senate, and Joint committees |
| [BillCosponsor](./tables/bill-cosponsors) | `allBillCosponsors` | Cosponsor records for bills |
| [BillCommittee](./tables/bill-committees) | `allBillCommittees` | Committee referrals for bills |
| [CommitteeMembership](./tables/committee-memberships) | `allCommitteeMemberships` | Current committee membership rosters |

## Common patterns

### Filtering

Every `allXxx` query accepts a `filter` argument with per-field conditions:

```graphql
{
  allVotes(
    filter: {
      chamber: { equalTo: "s" }
      category: { equalTo: "nomination" }
      congress: { greaterThanOrEqualTo: 117 }
    }
  ) {
    nodes { voteId votedAt question result }
  }
}
```

String fields support `equalTo`, `notEqualTo`, `includes`, `startsWith`, and more.
Numeric fields support `equalTo`, `lessThan`, `greaterThan`, `between`, etc.

### Pagination

All list queries use cursor-based pagination via `first` / `after` (forward) or `last` / `before` (backward):

```graphql
{
  allVotes(first: 20, after: "cursor-from-previous-page") {
    pageInfo { hasNextPage endCursor }
    nodes { voteId votedAt }
  }
}
```

### Ordering

Pass an `orderBy` enum value — field names are `SCREAMING_SNAKE_CASE` suffixed with `_ASC` or `_DESC`:

```graphql
{
  allLegislators(orderBy: LAST_NAME_ASC, first: 50) {
    nodes { officialFull }
  }
}
```

### Nested relationships

Foreign keys are automatically resolved as nested fields — no manual joins required:

```graphql
{
  allVotePositions(
    filter: { voteId: { equalTo: "s83-119.2025" } }
  ) {
    nodes {
      position
      party
      legislatorByBioguideId {
        officialFull
      }
      voteByVoteId {
        question
        result
        votedAt
      }
    }
  }
}
```

Reverse relationships (one-to-many) return a connection with `nodes`:

```graphql
{
  allLegislators(
    filter: { lastName: { equalTo: "Warren" } }
  ) {
    nodes {
      officialFull
      legislatorTermsByBioguideId {
        nodes { startDate endDate state termType party }
      }
    }
  }
}
```

### Aggregation

Some common counts are exposed as **aggregates** — the database does
the grouping, so you don't have to fetch every position row and tally it
client-side. Each is a filterable connection like any other type. Filter them to
the slice you care about (a vote, a member, a congress) rather than scanning
everything.

**Party breakdown of a vote** — how each party split, in one round-trip:

```graphql
{
  allVotePartyBreakdowns(filter: { voteId: { equalTo: "s83-119.2025" } }) {
    nodes { party position positions }
  }
}
```

Returns one row per (party, position), e.g. `{ party: "D", position: "Yea",
positions: 45 }`.

**Position totals for a vote** — the overall Yea/Nay/Present/Not Voting tally:

```graphql
{
  allVoteTotals(filter: { voteId: { equalTo: "s83-119.2025" } }) {
    nodes { position positions }
  }
}
```

**A member's voting record**, summarised by congress and vote category:

```graphql
{
  allMemberVotingSummaries(
    filter: {
      bioguideId: { equalTo: "W000817" }
      congress: { equalTo: 119 }
      category: { equalTo: "cloture" }
    }
  ) {
    nodes { position positions }
  }
}
```

`congress` and `category` are optional — omit them for a member's full record
across all congresses and categories.

**Voting similarity** — pairwise agreement between members within a congress is
precomputed in `allVoteSimilarities` (all congresses). Each row gives `sharedVotes`
(votes where both members cast a Yea/Nay), `agreed` (votes where they matched),
`agreementRate` (`agreed / sharedVotes`, ready to sort on), each member's party
(`partyA`/`partyB`, their dominant party across that congress+chamber), and
`crossParty` (true when the party labels differ). Filter by `congress` (and
usually `chamber`), and pair rate sorting with a `sharedVotes` floor — rates on
tiny overlaps are noise (but note a high floor also excludes members seated
mid-congress; lower it when they matter). Find the pairs with different party
labels who vote together most:

```graphql
{
  allVoteSimilarities(
    filter: {
      congress: { equalTo: 119 }
      chamber: { equalTo: "s" }
      crossParty: { equalTo: true }
      sharedVotes: { greaterThanOrEqualTo: 100 }
    }
    orderBy: AGREEMENT_RATE_DESC
    first: 10
  ) {
    nodes {
      legislatorByMemberA { officialFull }
      legislatorByMemberB { officialFull }
      partyA partyB sharedVotes agreementRate
    }
  }
}
```

The top of that ranking is naturally dominated by Independents: each `I` label
counts as its own party, so a senator who caucuses (and votes) with the
Democrats still forms "cross-party" pairs with them. For strictly D-vs-R
pairs, filter both party orders explicitly instead of `crossParty`:
`or: [{ partyA: { equalTo: "D" }, partyB: { equalTo: "R" } }, { partyA: { equalTo: "R" }, partyB: { equalTo: "D" } }]`.

Or a member's closest allies in a given congress:

```graphql
{
  allVoteSimilarities(
    filter: {
      congress: { equalTo: 119 }
      chamber: { equalTo: "s" }
      memberA: { equalTo: "W000817" }
      sharedVotes: { greaterThanOrEqualTo: 100 }
    }
    orderBy: AGREEMENT_RATE_DESC
    first: 5
  ) {
    nodes { memberB sharedVotes agreed agreementRate }
  }
}
```

Pairs are stored once with `memberA < memberB` (by bioguide id), so to find all
of one member's pairings you may need to match on `memberA` **or** `memberB` —
and `partyA`/`partyB` follow that member order too. That's why party-specific
matchups need the both-orders `or:` filter shown above, while `crossParty` is
order-free.

**Member-vs-party agreement** — how often each member voted *with a party* is
precomputed in `allMemberPartyAgreements` (all congresses). On each vote, a party's
"position" is its majority of Yea/Nay, and a member agrees when their Yea/Nay
matches it. Each row gives `sharedVotes` (votes where the member cast Yea/Nay and
the party had a majority), `agreed`, and `agreementRate` (`agreed / sharedVotes`,
ready to sort on). `otherParty` includes the member's *own* party — that row is a
party-loyalty measure. Which Democrats most often voted with Republicans this
Congress:

```graphql
{
  allMemberPartyAgreements(
    filter: {
      congress: { equalTo: 119 }
      memberParty: { equalTo: "D" }
      otherParty: { equalTo: "R" }
      sharedVotes: { greaterThanOrEqualTo: 20 }
    }
    orderBy: AGREEMENT_RATE_DESC
    first: 5
  ) {
    nodes {
      agreementRate
      sharedVotes
      legislatorByBioguideId { officialFull }
    }
  }
}
```

The `sharedVotes` floor filters out members with too few comparable votes to be
meaningful. Drop `memberParty`/`otherParty` to compare a member against every
party at once.

---

:::note
The per-type pages in this section are generated from the [`db/migrations/`](https://github.com/govql/govql/tree/main/us-congress/db/migrations) Flyway migration files by `scripts/generate-schema-docs.mjs`. Re-run `npm run generate-schema-docs` after schema changes.
:::
