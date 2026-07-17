# vote_similarity Cross-Party Ranking Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "which opposing-party members vote together most?" a one-query, server-side answer by adding `party_a`/`party_b`, a stored `agreement_rate`, and a `cross_party` flag to `vote_similarity` (issue #87).

**Architecture:** Four in-place columns on the existing aggregate table — two real columns filled by the ingester's per-congress rebuild (and backfilled once by the migration), two `GENERATED … STORED` columns Postgres maintains itself. PostGraphile then exposes `AGREEMENT_RATE_DESC` ordering and `crossParty` filtering with zero server code. Spec: `plans/superpowers/specs/2026-07-16-vote-similarity-cross-party-ranking-design.md`.

**Tech Stack:** PostgreSQL 18 (Flyway migrations), Node ingester (`pg`), PostGraphile v5, docker compose local stack.

## Global Constraints

- Applied migrations are immutable — never edit `V001`–`V006`; all schema work goes in the new `V007`.
- `party_a`/`party_b` = **dominant vote-time party** within the congress+chamber (most Yea/Nay positions in `vote_positions`; ties break alphabetically). Never latest-term party.
- The pairwise self-join in `build-aggregates.js` is memory-critical (see `AGENTS.md` "Aggregate rebuild memory") — the party join must attach to the *grouped* rows, never to the pairwise stream, and the `SET LOCAL` block must not change.
- CHANGELOG entries are API-consumer-facing only, under `## [Unreleased]`.
- SQL comments use PostGraphile-visible `COMMENT ON …` with `E'…'` strings; escape apostrophes as `''`.
- `pipeline.manifest.js` / `PIPELINE.md` are table-granular and unchanged — do not touch.
- Do NOT push or open a PR — the user performs all GitHub operations.
- Local stack prerequisite: `dotenvx` must decrypt `us-congress/.env` (the box has run this stack before). If `dotenvx run` fails, stop and report — do not improvise credentials.

**Working directory for all commands:** `us-congress` unless stated.

---

### Task 1: Local baseline — stack up, real + synthetic data, pre-change state captured

No repo files change in this task (nothing to commit). It builds the environment every later verification depends on, **before** V007 exists, so the migration's backfill runs against realistically-populated rows exactly as it will in production.

**Files:** none (environment only).

**Interfaces:**
- Produces: a running local stack (`postgres`, `redis`, `server`, `ingester`, `scraper`) with congress 119 real data + synthetic congress 999, `vote_similarity` populated by the **old** build code (no party columns), and a psql helper alias used by every later task.

- [ ] **Step 1: Bring the stack up (old code, migrations V001–V006)**

```bash
cd us-congress
dotenvx run -- docker compose -f compose.yml -f compose.dev.yml up --build -d postgres redis server ingester scraper
docker ps --format '{{.Names}}\t{{.Status}}' | grep us-congress
```

Expected: five `us-congress-*` containers Up (flyway ran as one-shot and exited). Define the psql helper for later steps:

```bash
PSQL() { docker exec us-congress-postgres-1 sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -c \"$1\""; }
```

- [ ] **Step 2: Populate legislators + congress 119 votes (real data)**

```bash
docker exec us-congress-scraper-1 /usr/local/bin/update-legislators.sh
docker exec us-congress-scraper-1 /usr/local/bin/usc-run votes --congress=119
docker exec us-congress-ingester-1 sh -c "node /app/src/ingest-legislators.js && node /app/src/ingest-votes.js"
PSQL "SELECT count(*) FROM votes WHERE congress = 119"
```

Expected: nonzero vote count (order of 1,000+). The scrape is the slow step (minutes).

- [ ] **Step 3: Insert the synthetic congress-999 fixture**

Four synthetic senators on ten votes, engineered so every party rule has a
deterministic expected answer: Alice (D throughout), Bob (R throughout),
Carol (mid-congress switcher, 6 votes as D then 4 as I → dominant **D**),
Dave (exact 5–5 tie between I and R → alphabetical tie-break → **I**).

```bash
docker exec -i us-congress-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
INSERT INTO legislators (bioguide_id, first_name, last_name) VALUES
  ('Z00001','Alice','Test'), ('Z00002','Bob','Test'),
  ('Z00003','Carol','Test'), ('Z00004','Dave','Test');

INSERT INTO votes (vote_id, chamber, congress, session, number, question)
SELECT 's' || n || '-999.2026', 's', 999, '2026', n, 'synthetic fixture vote ' || n
FROM generate_series(1, 10) n;

-- Alice: D on all, Yea on all.
INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
SELECT 's' || n || '-999.2026', 'Z00001', 'Yea', 'D', 'AA' FROM generate_series(1,10) n;

-- Bob: R on all; Yea 1-3, Nay 4-10.
INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
SELECT 's' || n || '-999.2026', 'Z00002',
       CASE WHEN n <= 3 THEN 'Yea' ELSE 'Nay' END, 'R', 'AA'
FROM generate_series(1,10) n;

-- Carol: D on votes 1-6, I on 7-10 (switcher; dominant D). Yea 1-6, Nay 7-10.
INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
SELECT 's' || n || '-999.2026', 'Z00003',
       CASE WHEN n <= 6 THEN 'Yea' ELSE 'Nay' END,
       CASE WHEN n <= 6 THEN 'D' ELSE 'I' END, 'AA'
FROM generate_series(1,10) n;

-- Dave: I on votes 1-5, R on 6-10 (exact tie; alphabetical -> I). Yea 1-8, Nay 9-10.
INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
SELECT 's' || n || '-999.2026', 'Z00004',
       CASE WHEN n <= 8 THEN 'Yea' ELSE 'Nay' END,
       CASE WHEN n <= 5 THEN 'I' ELSE 'R' END, 'AA'
FROM generate_series(1,10) n;
SQL
```

Hand-computed expectations for congress 999 (used to verify in Tasks 2–3):

| pair | shared | agreed | rate | party_a | party_b | cross_party |
|---|---|---|---|---|---|---|
| Z00001–Z00002 (Alice–Bob) | 10 | 3 | 0.3 | D | R | true |
| Z00001–Z00003 (Alice–Carol) | 10 | 6 | 0.6 | D | D | **false** |
| Z00001–Z00004 (Alice–Dave) | 10 | 8 | 0.8 | D | I | true |
| Z00002–Z00003 (Bob–Carol) | 10 | 7 | 0.7 | R | D | true |
| Z00002–Z00004 (Bob–Dave) | 10 | 5 | 0.5 | R | I | true |
| Z00003–Z00004 (Carol–Dave) | 10 | 8 | 0.8 | D | I | true |

(Bob–Carol: votes 1–3 both Yea, 4–6 Bob Nay/Carol Yea, 7–10 both Nay → 3+4=7.)

- [ ] **Step 4: Build aggregates with the OLD code and capture the baseline**

```bash
docker exec us-congress-ingester-1 node /app/src/build-aggregates.js
PSQL "SELECT congress, count(*) FROM vote_similarity GROUP BY 1 ORDER BY 1"
PSQL "SELECT member_a, member_b, shared_votes, agreed FROM vote_similarity WHERE congress = 999 ORDER BY member_a, member_b"
```

Expected: rows for congress 119 and 999; the six 999 rows match the shared/agreed columns of the table above. Confirm the new GraphQL fields do NOT exist yet (baseline "failing test"):

```bash
curl -sS http://localhost:4000/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ allVoteSimilarities(first: 1) { nodes { agreementRate } } }"}'
```

Expected: `errors` containing `Cannot query field \"agreementRate\"`.

---

### Task 2: Migration `V007` — columns, backfill, index, comments

**Files:**
- Create: `us-congress/db/migrations/V007__vote_similarity_cross_party_ranking.sql`

**Interfaces:**
- Consumes: populated local stack from Task 1.
- Produces: `vote_similarity.party_a TEXT NOT NULL`, `party_b TEXT NOT NULL`, `agreement_rate REAL` (generated), `cross_party BOOLEAN` (generated), partial index `idx_vote_similarity_cross_party_rate`. Task 3's INSERT lists columns `(congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b)`.

- [ ] **Step 1: Write the migration**

Create `us-congress/db/migrations/V007__vote_similarity_cross_party_ranking.sql`:

```sql
-- Make "which opposing-party members vote together most?" a one-query,
-- server-side answer (issue #87): add each member's party to vote_similarity
-- plus a stored agreement_rate — PostGraphile then emits AGREEMENT_RATE_*
-- orderBy, exactly as on member_party_agreement — and a cross_party flag (the
-- GraphQL connection filter cannot compare two columns, so party_a <> party_b
-- must be materialized to be filterable). Ranking cannot be pushed to clients:
-- a House congress slice is ~96k pairs, and AGREED_DESC is a poor proxy for
-- the rate (300/300 = 100% sorts below 350/500 = 70%).

ALTER TABLE vote_similarity
  ADD COLUMN party_a TEXT,
  ADD COLUMN party_b TEXT,
  ADD COLUMN agreement_rate REAL GENERATED ALWAYS AS
    (agreed::real / NULLIF(shared_votes, 0)) STORED,
  ADD COLUMN cross_party BOOLEAN GENERATED ALWAYS AS
    (party_a IS DISTINCT FROM party_b) STORED;

-- Backfill: each member's dominant vote-time party within the congress+chamber
-- — the party they cast the most Yea/Nay positions under (vote_positions
-- snapshots party at vote time), ties broken alphabetically for determinism.
-- Same derivation the ingester's rebuild now computes (build-aggregates.js),
-- so a later rebuild reproduces these exact values.
WITH party_counts AS (
  SELECT v.congress, v.chamber, vp.bioguide_id, vp.party, count(*) AS positions
  FROM vote_positions vp
  JOIN votes v ON v.vote_id = vp.vote_id
  WHERE vp.position IN ('Yea', 'Nay')
  GROUP BY v.congress, v.chamber, vp.bioguide_id, vp.party
),
dominant_party AS (
  SELECT DISTINCT ON (congress, chamber, bioguide_id)
         congress, chamber, bioguide_id, party
  FROM party_counts
  ORDER BY congress, chamber, bioguide_id, positions DESC, party
)
UPDATE vote_similarity vs
SET party_a = da.party,
    party_b = db.party
FROM dominant_party da, dominant_party db
WHERE da.congress = vs.congress
  AND da.chamber  = vs.chamber
  AND da.bioguide_id = vs.member_a
  AND db.congress = vs.congress
  AND db.chamber  = vs.chamber
  AND db.bioguide_id = vs.member_b;

-- Every member in vote_similarity has Yea/Nay positions by construction, and
-- none of those rows lack a party (verified on live data, 2026-07-16), so the
-- backfill reaches every row. If that invariant ever breaks, failing loudly
-- here (and in the ingester's NOT NULL insert) is the intended behavior —
-- matching member_party_agreement.member_party, built from the same source.
ALTER TABLE vote_similarity
  ALTER COLUMN party_a SET NOT NULL,
  ALTER COLUMN party_b SET NOT NULL;

-- Serve the canonical query — top pairs by rate within a congress+chamber,
-- cross-party only — without a per-query sort of the whole slice.
CREATE INDEX idx_vote_similarity_cross_party_rate
  ON vote_similarity (congress, chamber, agreement_rate DESC)
  WHERE cross_party;

-- Restate the table comment (PostGraphile surfaces it as the type description;
-- agents read it via describe_type) and describe the new columns.
COMMENT ON TABLE vote_similarity IS E'Pairwise voting agreement, per congress: one row per (congress, chamber, member_a, member_b) with shared_votes (both cast Yea/Nay), agreed (voted the same), each member''s party, and a stored agreement_rate (agreed / shared_votes). Pairs are stored once with member_a < member_b (by bioguide id), so party_a/party_b follow member order, not a canonical party order — filter cross_party = true to select opposing-party pairs regardless of order. Rank with orderBy AGREEMENT_RATE_DESC plus a shared_votes floor (e.g. greaterThanOrEqualTo: 100); rates on tiny overlaps are noise. Maintained by the vote ingester. Join legislatorByMemberA / legislatorByMemberB for each member''s name and details; see member_party_agreement for member-vs-party loyalty.';

COMMENT ON COLUMN vote_similarity.party_a IS E'member_a''s dominant vote-time party in this congress+chamber — the party they cast the most Yea/Nay positions under (vote_positions snapshots party at vote time). A rare mid-congress switcher gets the party they voted under more often; ties break alphabetically.';

COMMENT ON COLUMN vote_similarity.party_b IS E'member_b''s dominant vote-time party in this congress+chamber — see party_a for the derivation.';

COMMENT ON COLUMN vote_similarity.agreement_rate IS E'agreed / shared_votes, stored so consumers can order by it (AGREEMENT_RATE_DESC). Meaningless on tiny overlaps — pair it with a shared_votes floor.';

COMMENT ON COLUMN vote_similarity.cross_party IS E'True when party_a <> party_b. The order-safe way to select opposing-party pairs: party columns follow member order (member_a < member_b by bioguide id), so filtering party_a/party_b directly must handle both orders.';
```

- [ ] **Step 2: Apply it**

```bash
dotenvx run -- docker compose -f compose.yml -f compose.dev.yml run --rm flyway migrate
```

Expected: `Successfully applied 1 migration … v007`.

- [ ] **Step 3: Verify schema, backfill, and fixture expectations**

```bash
PSQL "SELECT count(*) FROM vote_similarity WHERE party_a IS NULL OR party_b IS NULL"        # 0
PSQL "SELECT count(*) FROM vote_similarity WHERE agreement_rate <> agreed::real / shared_votes"  # 0
PSQL "SELECT count(*) FROM vote_similarity WHERE cross_party <> (party_a <> party_b)"       # 0
PSQL "SELECT member_a, member_b, party_a, party_b, cross_party, round(agreement_rate::numeric, 1) AS rate FROM vote_similarity WHERE congress = 999 ORDER BY member_a, member_b"
```

Expected 999 rows == the fixture table in Task 1 Step 3 — in particular
Carol (`Z00003`) always labeled `D` (dominant beats the 4 `I` votes) and Dave
(`Z00004`) always labeled `I` (tie → alphabetical), and Alice–Carol has
`cross_party = false`.

Sibling sanity (real data): each member's `party_a` matches their
most-shared-votes `member_party` row in `member_party_agreement`:

```bash
PSQL "SELECT count(*) FROM (
  SELECT DISTINCT ON (vs.member_a) vs.member_a, vs.party_a, mpa.member_party
  FROM vote_similarity vs
  JOIN member_party_agreement mpa
    ON mpa.congress = vs.congress AND mpa.chamber = vs.chamber
   AND mpa.bioguide_id = vs.member_a AND mpa.other_party = mpa.member_party
  WHERE vs.congress = 119
  ORDER BY vs.member_a, mpa.shared_votes DESC
) s WHERE party_a <> member_party"
```

Expected: `0`. Snapshot the backfilled values for Task 3's rebuild diff:

```bash
PSQL "CREATE UNLOGGED TABLE vote_similarity_backfill_check AS SELECT congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b FROM vote_similarity"
```

- [ ] **Step 4: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add us-congress/db/migrations/V007__vote_similarity_cross_party_ranking.sql
git commit -m "feat(us-congress): add party + agreement-rate columns to vote_similarity (#87)"
```

---

### Task 3: Ingester build stage fills the party columns

**Files:**
- Modify: `us-congress/ingester/src/build-aggregates.js:87-107` (the `vote_similarity` INSERT)

**Interfaces:**
- Consumes: the `V007` columns from Task 2 (`party_a`/`party_b NOT NULL`; generated columns must not be named in the INSERT).
- Produces: rebuild output byte-identical (for shared columns + parties) to the migration backfill.

- [ ] **Step 1: Update the INSERT**

In `us-congress/ingester/src/build-aggregates.js`, replace the block starting
`// Pairwise member-to-member agreement.` (the DELETE stays as-is; only the
comment and the INSERT query change):

```js
    // Pairwise member-to-member agreement. party_a/party_b are each member's
    // dominant vote-time party in the congress+chamber (most Yea/Nay positions
    // in cpos; ties break alphabetically) — derived per chamber so a member who
    // moved chambers mid-congress is labeled correctly in each. The dominant
    // map joins the ~100-150k grouped pair rows, NOT the ~100M-row pairwise
    // stream, so the memory-critical aggregate above work_mem is unchanged (see
    // AGENTS.md "Aggregate rebuild memory"). agreement_rate / cross_party are
    // GENERATED columns — Postgres fills them.
    await client.query('DELETE FROM vote_similarity WHERE congress = $1', [
      congress,
    ]);
    await client.query(
      `INSERT INTO vote_similarity
         (congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b)
       WITH cpos AS (
         SELECT vp.vote_id, vp.bioguide_id, vp.position, vp.party, v.congress, v.chamber
         FROM vote_positions vp
         JOIN votes v ON v.vote_id = vp.vote_id
         WHERE v.congress = $1 AND vp.position IN ('Yea', 'Nay')
       ),
       pairs AS (
         SELECT a.congress, a.chamber,
                a.bioguide_id AS member_a, b.bioguide_id AS member_b,
                count(*)::int AS shared_votes,
                count(*) FILTER (WHERE a.position = b.position)::int AS agreed
         FROM cpos a
         JOIN cpos b ON b.vote_id = a.vote_id AND a.bioguide_id < b.bioguide_id
         GROUP BY a.congress, a.chamber, a.bioguide_id, b.bioguide_id
       ),
       party_counts AS (
         SELECT chamber, bioguide_id, party, count(*) AS positions
         FROM cpos
         GROUP BY chamber, bioguide_id, party
       ),
       dominant_party AS (
         SELECT DISTINCT ON (chamber, bioguide_id) chamber, bioguide_id, party
         FROM party_counts
         ORDER BY chamber, bioguide_id, positions DESC, party
       )
       SELECT p.congress, p.chamber, p.member_a, p.member_b,
              p.shared_votes, p.agreed, da.party, db.party
       FROM pairs p
       JOIN dominant_party da ON da.chamber = p.chamber AND da.bioguide_id = p.member_a
       JOIN dominant_party db ON db.chamber = p.chamber AND db.bioguide_id = p.member_b`,
      [congress],
    );
```

Everything else in the file (the `SET LOCAL` block, `member_party_agreement`
INSERT, watermark, transaction) stays untouched.

- [ ] **Step 2: Syntax check + ingester test suite**

```bash
node --check us-congress/ingester/src/build-aggregates.js
cd us-congress/ingester && npm test && npm run check-pipeline-docs
```

Expected: no syntax error; existing tests pass; pipeline docs check passes
(the manifest didn't change). If `node`/`npm` aren't on the host, run inside
the container after Step 3's rebuild instead: `docker exec us-congress-ingester-1 npm test`.

- [ ] **Step 3: Rebuild the ingester image and force a full rebuild**

```bash
cd us-congress
dotenvx run -- docker compose -f compose.yml -f compose.dev.yml up --build -d ingester
PSQL "DELETE FROM vote_similarity_state"    # every congress becomes stale
docker exec us-congress-ingester-1 node /app/src/build-aggregates.js
```

Expected: log lines `Rebuilt aggregates for congress 119 …` and `… congress 999 …`, exit 0.

- [ ] **Step 4: Prove rebuild ≡ backfill**

```bash
PSQL "SELECT count(*) FROM ((SELECT * FROM vote_similarity_backfill_check EXCEPT SELECT congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b FROM vote_similarity) UNION ALL (SELECT congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b FROM vote_similarity EXCEPT SELECT * FROM vote_similarity_backfill_check)) d"
```

Expected: `0` (set-identical in both directions). Then drop the scratch table:

```bash
PSQL "DROP TABLE vote_similarity_backfill_check"
```

- [ ] **Step 5: Verify the GraphQL surface end-to-end**

PostGraphile introspects at startup — restart it to pick up V007, then run
the canonical query:

```bash
dotenvx run -- docker compose -f compose.yml -f compose.dev.yml restart server
sleep 3
curl -sS http://localhost:4000/graphql -H 'Content-Type: application/json' -d '{"query":"{ allVoteSimilarities(filter: {congress: {equalTo: 119}, chamber: {equalTo: \"s\"}, crossParty: {equalTo: true}, sharedVotes: {greaterThanOrEqualTo: 100}}, orderBy: AGREEMENT_RATE_DESC, first: 5) { nodes { legislatorByMemberA { officialFull } legislatorByMemberB { officialFull } partyA partyB sharedVotes agreementRate } } }"}'
```

Expected: 5 rows, `agreementRate` non-increasing, every row `partyA != partyB`,
names resolved inline. Also confirm the index serves the shape (optional):

```bash
PSQL "EXPLAIN (COSTS OFF) SELECT member_a FROM vote_similarity WHERE congress = 119 AND chamber = 's' AND cross_party ORDER BY agreement_rate DESC LIMIT 10"
```

Expected: a scan of `idx_vote_similarity_cross_party_rate` (no Sort node).

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add us-congress/ingester/src/build-aggregates.js
git commit -m "feat(us-congress): fill vote_similarity party columns in the aggregate rebuild (#87)"
```

---

### Task 4: Consumer docs — CHANGELOG + hand-written Aggregation section — and cleanup

**Files:**
- Modify: `us-congress/CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `us-congress/docs/docs/schema/index.md:179-202` (the "Voting similarity" block)

**Interfaces:**
- Consumes: the GraphQL field names verified in Task 3 Step 5 (`partyA`, `partyB`, `agreementRate`, `crossParty`, `AGREEMENT_RATE_DESC`).

- [ ] **Step 1: CHANGELOG entry**

In `us-congress/CHANGELOG.md`, directly under `## [Unreleased]`, add:

```markdown
### Added

- **Cross-party agreement ranking on `VoteSimilarity`**: each pair now carries
  `partyA` / `partyB` (each member's dominant vote-time party for that
  congress+chamber), a stored `agreementRate` (`agreed / sharedVotes` — so
  `orderBy: AGREEMENT_RATE_DESC` ranks server-side), and `crossParty`, a
  symmetric opposing-party flag that works regardless of pair storage order.
  "Which opposing-party members vote together most?" is now one query: filter
  `{ crossParty: { equalTo: true }, sharedVotes: { greaterThanOrEqualTo: 100 } }`
  and order by `AGREEMENT_RATE_DESC`. All four fields are filterable and
  orderable.
```

- [ ] **Step 2: Update the "Voting similarity" block in the Aggregation section**

In `us-congress/docs/docs/schema/index.md`, replace the block from
`**Voting similarity** — pairwise agreement…` through `…match on \`memberA\` **or** \`memberB\`.`
(currently lines 179–202) with:

```markdown
**Voting similarity** — pairwise agreement between members within a congress is
precomputed in `allVoteSimilarities` (all congresses). Each row gives `sharedVotes`
(votes where both members cast a Yea/Nay), `agreed` (votes where they matched),
`agreementRate` (`agreed / sharedVotes`, ready to sort on), each member's party
(`partyA`/`partyB`, their dominant party on those votes), and `crossParty`
(true when the parties differ). Filter by `congress` (and usually `chamber`),
and pair rate sorting with a `sharedVotes` floor — rates on tiny overlaps are
noise. Find the opposing-party pairs who vote together most:

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
and `partyA`/`partyB` follow that member order too. To select specific party
matchups (say D–R), filter both orders with `or:`; for "any opposing-party
pair", `crossParty` already handles order for you.
```

- [ ] **Step 3: Verify docs render assumptions**

```bash
grep -n "AGREED_DESC" us-congress/docs/docs/schema/index.md
```

Expected: no matches remain in the Voting similarity block (the old example is
gone). Eyeball the diff for fence balance (the block contains two ```graphql
fences inside the section).

- [ ] **Step 4: Remove the synthetic fixture and tidy the local stack**

```bash
docker exec -i us-congress-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
DELETE FROM vote_similarity WHERE congress = 999;
DELETE FROM member_party_agreement WHERE congress = 999;
DELETE FROM vote_similarity_state WHERE congress = 999;
DELETE FROM vote_positions WHERE bioguide_id IN ('Z00001','Z00002','Z00003','Z00004');
DELETE FROM votes WHERE congress = 999;
DELETE FROM legislators WHERE bioguide_id IN ('Z00001','Z00002','Z00003','Z00004');
SQL
```

Leave the stack running or `dotenvx run -- docker compose -f compose.yml -f compose.dev.yml down` per preference (volume persists either way).

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add us-congress/CHANGELOG.md us-congress/docs/docs/schema/index.md
git commit -m "docs(us-congress): document cross-party ranking fields on VoteSimilarity (#87)"
```

---

## Completion checklist (spec Definition of Done)

- [ ] Top-N-by-rate for a congress+chamber, cross-party only, returns correctly server-side (Task 3 Step 5).
- [ ] Each side's party + member FKs available inline on the ranked rows (Task 3 Step 5).
- [ ] Rebuild reproduces the migration backfill exactly (Task 3 Step 4).
- [ ] Switcher + tie determinism proven on the synthetic fixture (Task 2 Step 3).
- [ ] `us-congress/CHANGELOG.md` entry under `[Unreleased]` (Task 4).
- [ ] No push / no PR — hand off to the user for GitHub operations.
