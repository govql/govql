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

Some common counts are exposed as **aggregation views** — the database does the
grouping, so you don't have to fetch every position row and tally it client-side.
Each is a filterable connection like any other type. Filter them to the slice you
care about (a vote, a member) rather than scanning everything.

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

**Voting similarity** — for the **current congress**, pairwise agreement between
members is precomputed in `allVoteSimilarityCurrents`. Each row gives `sharedVotes`
(votes where both members cast a Yea/Nay) and `agreed` (votes where they matched);
compute the agreement ratio as `agreed / sharedVotes`. Find a member's closest
allies:

```graphql
{
  allVoteSimilarityCurrents(
    filter: { chamber: { equalTo: "s" }, memberA: { equalTo: "W000817" } }
    orderBy: AGREED_DESC
    first: 5
  ) {
    nodes { memberB sharedVotes agreed }
  }
}
```

Pairs are stored once with `memberA < memberB`, so to find all of one member's
pairings you may need to match on `memberA` **or** `memberB`.

---

:::note
The per-type pages in this section are generated from [`db/schema.sql`](https://github.com/govql/govql/blob/main/us-congress/db/schema.sql) by `scripts/generate-schema-docs.mjs`. Re-run `npm run generate-schema-docs` after schema changes.
:::
