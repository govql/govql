# vote_similarity Legislator FKs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `member_a`/`member_b` → `legislators` foreign keys (plus supporting indexes) to `vote_similarity` so PostGraphile exposes `legislatorByMemberA`/`legislatorByMemberB` and the indexed reverse relations.

**Architecture:** One new Flyway migration, `us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql`, adds two FK constraints, two btree indexes, and an enriched table comment. No ingester change and no data rebuild — existing rows already satisfy the constraint (built from `vote_positions`, which already `REFERENCES legislators`), so Postgres validates in place. PostGraphile derives the relations from the FKs on its next boot.

**Tech Stack:** PostgreSQL 18, Flyway 12.9 (one-shot `flyway migrate` service in `us-congress/compose.yml`), PostGraphile v5. No application code.

**Spec:** [plans/superpowers/specs/2026-07-09-vote-similarity-legislator-fks-design.md](../specs/2026-07-09-vote-similarity-legislator-fks-design.md)

## Global Constraints

- Migration file: `us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql` (follows the `V00N__snake_case.sql` convention).
- FK targets: `member_a` and `member_b` → `legislators (bioguide_id)`, plain `REFERENCES` (NO ACTION on delete/update — matches `member_party_agreement`).
- Constraint names: `vote_similarity_member_a_fkey`, `vote_similarity_member_b_fkey` (mirror Postgres' inline-`REFERENCES` auto-naming).
- Index names: `idx_vote_similarity_member_a`, `idx_vote_similarity_member_b` (follow existing `idx_<table>_<col>` pattern).
- **No** party columns, **no** ingester (`build-aggregates.js`) change, **no** data rebuild, **no** MCP-server change / PyPI publish, **no** production rollout. Scope is: author the migration + verify on the local docker stack.
- Verification is **operational** — there is no automated DB test harness (only `ingester/src/cursor-state.test.js` exists). "Tests" here are psql + GraphQL checks with expected outputs.
- Local DB: container `us-congress-postgres-1`, database `govql-data`, user/password `govql`/`govql`.
- All `docker compose` commands run from `us-congress/` and need the project's local env (`POSTGRES_USER=govql`, `POSTGRES_PASSWORD=govql`, `POSTGRES_DB=govql-data`) — provide it however you normally bring the stack up (e.g. `dotenvx run -- docker compose …`, or exported vars). The `docker exec us-congress-postgres-1 psql …` commands do **not** need this.
- Commits are authored by Alex with **no** Claude co-author trailer (`includeCoAuthoredBy: false` is set) — do not add one.

---

### Task 1: Add legislator FKs + indexes to `vote_similarity` (V004 migration)

**Files:**
- Create: `us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql`
- Reference (do not modify): `us-congress/db/migrations/V001__baseline_schema.sql:277-288` (the `vote_similarity` table + its current comment), `:456-470` (the `member_party_agreement` FK exemplar).

**Interfaces:**
- Consumes: nothing (only task; the constraint relies on existing `legislators.bioguide_id` PK and existing `vote_similarity` data).
- Produces: GraphQL relations `VoteSimilarity.legislatorByMemberA: Legislator`, `VoteSimilarity.legislatorByMemberB: Legislator`, and reverse connections `Legislator.voteSimilaritiesByMemberA` / `voteSimilaritiesByMemberB`. Future work (v0.4 `most_agreeing_pairs`, and a downstream `execute_graphql` docstring note) depends on these names.

- [ ] **Step 1: Bring up the local DB and capture the baseline (the "red" state)**

```bash
# from us-congress/ (with local env available)
docker compose up -d postgres
# wait for healthy, then inspect the current table
docker exec us-congress-postgres-1 psql -U govql -d govql-data -c "\d vote_similarity"
```

Expected: the output shows the composite primary key but **no** "Foreign-key constraints:" referencing `legislators`, and **no** `idx_vote_similarity_member_a` / `idx_vote_similarity_member_b` under "Indexes:". This confirms the change hasn't been made yet.

- [ ] **Step 2: Orphan pre-check (integrity precondition — hard gate)**

```bash
docker exec us-congress-postgres-1 psql -U govql -d govql-data -tAc \
"SELECT count(*) FROM vote_similarity vs LEFT JOIN legislators l ON vs.member_a = l.bioguide_id WHERE l.bioguide_id IS NULL"
docker exec us-congress-postgres-1 psql -U govql -d govql-data -tAc \
"SELECT count(*) FROM vote_similarity vs LEFT JOIN legislators l ON vs.member_b = l.bioguide_id WHERE l.bioguide_id IS NULL"
```

Expected: `0` and `0`. **If either is nonzero, STOP** — the FK cannot be added cleanly; investigate before continuing (do not proceed to write/apply).

- [ ] **Step 3: Write the migration file**

Create `us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql` with exactly:

```sql
-- Add legislator foreign keys to vote_similarity.member_a / member_b so
-- PostGraphile exposes legislatorByMemberA / legislatorByMemberB (member name +
-- navigation inline on each pair), matching the FK member_party_agreement
-- already carries. Integrity holds by construction: member_a/member_b are built
-- from vote_positions (which REFERENCES legislators), so every value resolves —
-- the constraint validates in place, no rewrite or backfill.

ALTER TABLE vote_similarity
  ADD CONSTRAINT vote_similarity_member_a_fkey
    FOREIGN KEY (member_a) REFERENCES legislators (bioguide_id),
  ADD CONSTRAINT vote_similarity_member_b_fkey
    FOREIGN KEY (member_b) REFERENCES legislators (bioguide_id);

-- Support the reverse relations PostGraphile now exposes
-- (legislator -> voteSimilaritiesByMemberA / voteSimilaritiesByMemberB).
-- member_a/member_b are the 3rd/4th columns of the composite PK, so the PK
-- index does not serve single-column lookups on them.
CREATE INDEX idx_vote_similarity_member_a ON vote_similarity (member_a);
CREATE INDEX idx_vote_similarity_member_b ON vote_similarity (member_b);

-- Restate the table comment to point consumers at the new relations and to make
-- clear that party is NOT reachable via legislators (it is per-congress).
COMMENT ON TABLE vote_similarity IS E'Pairwise voting agreement, per congress: one row per (congress, chamber, member_a, member_b) with shared_votes (both cast Yea/Nay) and agreed (voted the same). Pairs are stored once with member_a < member_b. Maintained by the vote ingester. Compute agreement as agreed::float / shared_votes. Join legislatorByMemberA / legislatorByMemberB for each member''s name and details; party is per-congress and not on legislators — see member_party_agreement for a member''s party in a given congress.';
```

- [ ] **Step 4: Apply the migration**

```bash
# from us-congress/ (with local env available)
docker compose run --rm flyway
```

Expected: output ends with a success line naming the new version, e.g. `Successfully applied 1 migration to schema "public"` and lists `V004`. 

If Flyway instead reports a **failed** migration (e.g. a SQL typo), clean the failed history entry, fix the file, and retry:
```bash
docker compose run --rm flyway repair
# fix V004__…sql, then:
docker compose run --rm flyway
```

- [ ] **Step 5: Verify structure (the "green" gate — psql)**

```bash
# Foreign keys
docker exec us-congress-postgres-1 psql -U govql -d govql-data -tAc \
"SELECT conname FROM pg_constraint WHERE conrelid='vote_similarity'::regclass AND contype='f' ORDER BY conname"
# Indexes
docker exec us-congress-postgres-1 psql -U govql -d govql-data -tAc \
"SELECT indexname FROM pg_indexes WHERE tablename='vote_similarity' AND indexname LIKE 'idx_%' ORDER BY indexname"
```

Expected (constraints):
```
vote_similarity_member_a_fkey
vote_similarity_member_b_fkey
```
Expected (indexes):
```
idx_vote_similarity_member_a
idx_vote_similarity_member_b
```

Both must match exactly. This gate is the hard proof; Step 6 confirms the downstream consequence.

- [ ] **Step 6: Verify the GraphQL surface (confirmatory)**

Restart PostGraphile so it re-introspects, then check the type:

```bash
# from us-congress/ (with local env available)
docker compose up -d redis
docker compose up -d --force-recreate server
# give it a couple seconds to boot, then introspect VoteSimilarity's fields
docker compose exec -T server node -e 'fetch("http://localhost:4000/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"{__type(name:\"VoteSimilarity\"){fields{name}}}"})}).then(r=>r.json()).then(j=>{const n=j.data.__type.fields.map(f=>f.name);console.log(["legislatorByMemberA","legislatorByMemberB"].every(x=>n.includes(x))?"OK relations present":"MISSING among: "+JSON.stringify(n))}).catch(e=>{console.error(e);process.exit(1)})'
```

Expected: `OK relations present`.

Optional forward data query (only meaningful if `vote_similarity` is populated — an empty `nodes` array is fine on a fresh DB and is not a failure):

```bash
docker compose exec -T server node -e 'fetch("http://localhost:4000/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"{allVoteSimilarities(first:2){nodes{memberA memberB legislatorByMemberA{lastName} legislatorByMemberB{lastName}}}}"})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.data,null,2)))'
```

Expected: up to 2 nodes, each with `legislatorByMemberA.lastName` / `legislatorByMemberB.lastName` populated.

- [ ] **Step 7: Commit**

```bash
git add us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql
git commit -m "feat: add legislator foreign keys + indexes to vote_similarity (#63)"
```

---

## Self-Review

**1. Spec coverage:**
- FK on `member_a`/`member_b` → Step 3 (DDL) ✓
- Supporting indexes on both → Step 3 ✓
- Table-comment enrichment (points at `member_party_agreement` for party) → Step 3 `COMMENT ON TABLE` ✓
- No party columns / no ingester change / no rebuild → Global Constraints + nothing in the task touches them ✓
- Local-verify scope (introspection + forward/reverse) → Steps 5–6 ✓
- Orphan pre-check → Step 2 ✓
- Integrity-by-construction rationale → migration header comment + Step 2 ✓

**2. Placeholder scan:** No TBD/TODO; every step has exact commands and expected output; the SQL is complete. ✓

**3. Type/name consistency:** Constraint names (`vote_similarity_member_{a,b}_fkey`), index names (`idx_vote_similarity_member_{a,b}`), the migration filename, the container/db/user, and the GraphQL field names (`legislatorByMemberA`/`legislatorByMemberB`) are identical across the Global Constraints, the DDL (Step 3), and the verification queries (Steps 5–6). ✓
