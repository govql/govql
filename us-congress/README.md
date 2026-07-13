# Votes

US Senate and House roll call vote data, served as a GraphQL API via PostGraphile v5.

## Prerequisites

- [dotenvx](https://dotenvx.com/docs/install) for secret management
- Docker Desktop (Mac/Windows) or Docker Engine + Compose plugin (Linux)

---

## Local Development

The dev override re-exposes port 4000 and skips nginx (no certs needed locally).

```bash
dotenvx run -- docker compose -f compose.yml -f compose.dev.yml up --build postgres redis server ingester scraper
```

The GraphQL API and Ruru explorer are available at `http://localhost:4000/graphql`.

### First-run: populate the database

The scrapers and ingesters run on cron schedules (votes every hour, legislators once daily at 02:00), so on a fresh volume you need to trigger the initial run manually. Do this after the stack is up:

```bash
# 1. Scrape legislators (clones repo on first run; subsequent runs pull latest)
docker exec us-congress-scraper-1 /usr/local/bin/update-legislators.sh

# 2. Scrape all historical vote data (slow — can take 10–30 min on first run)
docker exec us-congress-scraper-1 /usr/local/bin/usc-run votes

# 3. Ingest into PostgreSQL (legislators must go first — vote positions FK against them)
docker exec us-congress-ingester-1 sh -c "node /app/src/ingest-legislators.js && node /app/src/ingest-votes.js"
```

The same sequence works any time you need to force a re-sync (e.g. after recreating volumes).

For the Docusaurus site, run its dev server separately from the `docs/` directory:

```bash
cd ../docs
npm run start   # http://localhost:3000
```

### Backfilling historical data

To backfill historical congressional data, here's a helpful bit of shell script:
```bash
for congress in $(seq 119 -1 93); do
  echo "=== Scraping Congress $congress ==="
  docker exec us-congress-scraper-1 /usr/local/bin/usc-run votes --congress=$congress --debug
  echo "=== Ingesting Congress $congress ==="
  docker exec us-congress-ingester-1 node /app/src/ingest-votes.js
done
```
---

## Database schema & migrations

The Postgres schema is managed with [Flyway](https://documentation.red-gate.com/flyway). Migrations live in [`db/migrations/`](db/migrations), named `Vnnn__description.sql` (zero-padded, sequential). A one-shot `flyway` service applies any pending migrations automatically on every `docker compose up` — the API server waits for it to finish before starting — so **schema changes deploy with the same `up` command as code**, no manual `psql`.

**To change the schema:** add the next migration, e.g. `db/migrations/V003__add_foo.sql`. Never edit a migration that has already been applied — Flyway checksums them — always add a new one. Keep migrations hand-written, readable SQL: the API reference pages are generated from them by [`docs/scripts/generate-schema-docs.mjs`](docs/scripts/generate-schema-docs.mjs) (re-run `npm run generate-schema-docs` after schema changes).

**Service-account roles** (e.g. `grafana_reader`) are created at database init from [`db/roles/`](db/roles) (fresh volume only); their grants live in migrations (see `db/migrations/V002__grafana_reader_grants.sql`).

### Adopting Flyway on an existing database (one-time)

A database that already had the schema before Flyway must be **baselined** once, so Flyway records the current state as already-applied instead of trying to recreate it:

```bash
dotenvx run -- docker compose run --rm flyway \
  -baselineVersion=1 -baselineDescription="pre-Flyway schema" baseline
```

After that, `docker compose up` applies only newer migrations. A brand-new (empty) database needs no baseline — Flyway builds it from `V001` on the first `up`.

## Changelog

Consumer-facing API changes are tracked in [`CHANGELOG.md`](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/) format, date-stamped — the API is versionless and evolves additively, so there are no release tags).

- **Scope:** only changes a person querying the API would notice — new/changed types, fields, enums, filters, connections; deprecations and removals; query behavior (rate/depth/complexity limits, pagination, errors); and data coverage. Internal scraper/ingester/infra/docs changes do **not** belong here.
- **When you make a consumer-facing change:** add a bullet under the `## [Unreleased]` heading in the same PR, using the relevant category (Added / Changed / Deprecated / Removed / Fixed / Security). The PR template has a checkbox reminder.
- **Cutting an entry:** when a notable batch ships (typically at deploy), rename `## [Unreleased]` to today's date (`## [YYYY-MM-DD]`) and add a fresh empty `Unreleased` section above it.
- **Deprecations:** mark fields `@deprecated` and keep them for ≥90 days; announce under `Deprecated` before removal. See the policy at the top of `CHANGELOG.md`.

The changelog is rendered on the docs site at `/docs/changelog`, as a section in the API Reference sidebar. The page `docs/docs/schema/changelog.md` is **generated** from `CHANGELOG.md` by `docs/scripts/sync-changelog.mjs` (runs automatically on `npm run build` / `npm run start`; run `npm run sync-changelog` to regenerate manually). Edit `CHANGELOG.md`, not the generated page.

---

## Deploying to DigitalOcean

### 1. Root-only setup

Create a 1 GB Droplet running Ubuntu 24.04. SSH in as root and run:

```bash
# Swap (required — RAM is too constrained without it)
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl -p

# Firewall
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable

# Docker
curl -fsSL https://get.docker.com | sh

# Create a dedicated user and give it Docker access
adduser --disabled-password --gecos "" govql
usermod -aG docker govql

# Create app directory owned by govql
mkdir -p /opt/govql
chown govql:govql /opt/govql

# Systemd service (runs as govql, not root). A one-shot `up -d`, not a
# foreground supervisor: the CI deploy recreates containers out from under
# systemd, so nothing may hold the stack in the foreground. Crash recovery
# comes from each service's `restart: always` in compose. up.sh derives
# IMAGE_TAG from the checked-out commit, so a reboot restores exactly the
# images that were last deployed.
tee /etc/systemd/system/govql.service <<EOF
[Unit]
Description=GovQL
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=govql
WorkingDirectory=/opt/govql/us-congress
ExecStart=/opt/govql/us-congress/deploy/up.sh
ExecStop=docker compose down

[Install]
WantedBy=multi-user.target
EOF

systemctl enable govql

# Authorize the CI deploy key for the govql user. The operator generates the
# keypair (ed25519, no passphrase); the private half lives only in the GitHub
# `production` environment secret DEPLOY_SSH_KEY. The forced command means the
# key can do exactly one thing — hand a commit sha to deploy/ci-deploy.sh,
# which validates it, refuses rollbacks, checks it out, and deploys it with
# digest verification. `restrict` disables forwarding, PTY, etc.
sudo -u govql bash -c '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  echo "command=\"/opt/govql/us-congress/deploy/ci-deploy.sh\",restrict ssh-ed25519 AAAA_PUBLIC_KEY_HERE govql-deploy-ci" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
'

# Disable root SSH login — verify you can still SSH in as nate first!
# Test with: ssh nate@YOUR_DROPLET_IP (in a separate terminal before running this)
sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh
```

The `nate` user already has SSH access. For all remaining steps, switch to the `govql` user via:

```bash
sudo -u govql -i
```

`nate` can use this any time to act as `govql` without needing a separate SSH session.

### 2. Point DNS to the droplet

In your Gandi DNS settings, set the following records pointing to the droplet's IP and wait for propagation before continuing:

| Type  | Name  | Value                                    |
|-------|-------|------------------------------------------|
| A     | @     | YOUR_DROPLET_IPV4                        |
| AAAA  | @     | YOUR_DROPLET_IPV6                        |
| CNAME | www   | govql.us.                                |

### 3. Clone the repo and add secrets

GitHub requires a Personal Access Token (PAT) or SSH key — password auth is not supported.

```bash
# Option A: PAT (generate at https://github.com/settings/tokens/new with repo scope)
git clone https://YOUR_PAT@github.com/govql/govql.git /opt/govql

# Option B: SSH (add your public key to GitHub → Settings → SSH keys first)
git clone git@github.com:govql/govql.git /opt/govql
```

Copy your `.env.keys` file to the droplet (never commit this file):

```bash
# Run this locally
scp us-congress/.env.keys govql@YOUR_DROPLET_IP:/opt/govql/us-congress/.env.keys
```

### 4. Install dotenvx

```bash
mkdir -p ~/.local/bin
curl -fsS "https://dotenvx.sh?directory=$HOME/.local/bin" | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### 5. Obtain a wildcard TLS certificate

Use [acme.sh](https://github.com/acmesh-official/acme.sh) — certbot's Python dependencies conflict on Ubuntu 24.04.

Create a Personal Access Token at Gandi → Settings → Security with the "Manage domain technical configurations" permission, then:

```bash
curl https://get.acme.sh | sh -s email=YOUR_EMAIL
source ~/.bashrc

export GANDI_LIVEDNS_TOKEN="YOUR_GANDI_PAT"

~/.acme.sh/acme.sh --issue --dns dns_gandi_livedns -d govql.us -d '*.govql.us'

# Install certs to the path the stack expects
mkdir -p /opt/govql/certs/live/govql.us
~/.acme.sh/acme.sh --install-cert -d govql.us \
  --cert-file /opt/govql/certs/live/govql.us/cert.pem \
  --key-file /opt/govql/certs/live/govql.us/privkey.pem \
  --fullchain-file /opt/govql/certs/live/govql.us/fullchain.pem
```

acme.sh auto-installs a renewal cron job — no further setup needed.

### 6. Set ENABLE_GRAPHIQL

In `/opt/govql/us-congress/.env`, set:

```
ENABLE_GRAPHIQL=true
```

### 7. Start the stack

The droplet never builds — it pulls the SHA-tagged images CI pushed for the
checked-out commit:

```bash
cd /opt/govql/us-congress
deploy/up.sh --pull
```

The API is live at `https://api.govql.us/graphql` and the site at `https://govql.us`.

### 8. Populate the database

The scrapers and ingesters run on cron schedules, so on a fresh deployment you need to trigger the initial run manually:

```bash
# Scrape legislators (clones repo on first run)
docker exec us-congress-scraper-1 /usr/local/bin/update-legislators.sh

# Scrape current session votes
docker exec us-congress-scraper-1 /usr/local/bin/usc-run votes

# Ingest into PostgreSQL (legislators must go first)
docker exec us-congress-ingester-1 sh -c "node /app/src/ingest-legislators.js && node /app/src/ingest-votes.js"
```

## Deploying changes (one-click)

Every change — code, schema, docs site — ships through the same pipeline; the
droplet never builds:

1. **Merge to `main`.** CI builds the four images and pushes them to GHCR
   tagged with the commit SHA (`.github/workflows/us-congress.yml`).
2. **Approve the deploy.** The `deploy` job waits on the GitHub `production`
   environment's required reviewer — Slack pings when it's waiting. One click
   in the Actions run releases it.
3. **The droplet swaps the stack.** The job SSHes in as the unprivileged
   `govql` user with the deploy-only key (pinned host key, strict checking).
   The key's forced command — `deploy/ci-deploy.sh` — is the only thing it
   can run: it validates the sha, refuses rollbacks to an ancestor of what's
   deployed, checks the commit out, and hands off to `deploy/deploy.sh`,
   which pulls the four SHA-tagged app images and **refuses to start unless
   their digests match what CI just built** (GHCR tags are mutable; digests
   are not). Then `docker compose up -d`: Flyway applies any pending
   `db/migrations/V*.sql`, and the API server re-introspects the schema.
   Docs-site changes ride along — the Docusaurus build is baked into the
   `nginx` image.
4. **The outcome is recorded.** Slack reports success or failure with the SHA
   and a run link, and the run appears as a GitHub deployment on the
   `production` environment.

Because all four images are retagged every deploy, all four containers are
recreated together — nginx re-resolves the `server` container's IP on start,
so the stale-IP 502 that manual partial restarts could cause doesn't apply to
a pipeline deploy. If you ever bounce `server` by hand, follow it with
`docker compose restart nginx`.

**Removing the approval gate** (graduating to continuous deployment): delete
the required reviewer from the `production` environment (repo Settings →
Environments → production). That one setting is the whole gate — no workflow
change needed.

**Manual/emergency deploy** — the same thing the CI job runs:

```bash
sudo -u govql -i
cd /opt/govql
git fetch origin && git checkout --detach <sha>
us-congress/deploy/up.sh --pull
```

> **First time only:** this production database predates Flyway, so run the one-time `baseline` (see [Adopting Flyway on an existing database](#adopting-flyway-on-an-existing-database-one-time)) **before** the first `up` that includes the `flyway` service — otherwise Flyway would try to recreate the existing schema and fail.

## Hardening against probing

The box is continuously probed by automated scanners (raw-IP TLS handshakes, WordPress/PHP
webshell paths, etc.). None of it is a breach, but the defaults let it through noisily. The
nginx config (`nginx/nginx.conf`) handles the bulk of it cheaply:

- **Real 404s.** Unknown paths return a real `404` (the themed Docusaurus 404 page) instead of
  silently serving the homepage with a `200`. This stops advertising "everything exists" to
  scanners and makes the logs meaningful — a successful probe is now distinguishable from a
  failed one.
- **Refusing junk.** Known probe paths (`/wp-admin`, `/wp-login`, …) and server-side script
  extensions (`.php`, `.asp`, `.jsp`, `.env`, …) get `444` (connection closed, no response).
  Nothing here is WordPress or a scripting runtime, so these can never be legitimate.
- **Rate limiting.** Per-IP request and connection limits (`limit_req` / `limit_conn`) cap
  abusive bursts and return `429`. The static site's limits are generous (a page load pulls many
  assets at once, and immutable `/assets/` + `/img/` are exempt from request throttling); the API
  limit is a coarse flood shield in front of PostGraphile's own finer 100 req/min per-IP limiter.
- **Refusing raw-IP / unknown-host TLS.** A `:443` `default_server` with `ssl_reject_handshake`
  rejects TLS handshakes that don't match a hostname we serve, so scanners hitting the raw IP
  never get a request processed.

The host firewall (`ufw`, see [Root-only setup](#1-root-only-setup)) already limits inbound to
22/80/443, which covers the firewall-minimization side of hardening.

### Deferred next layers (not yet implemented)

These are higher-effort layers that live in infrastructure/account configuration rather than this
repo. Documented here so the rationale isn't lost:

- **Dynamic IP-blocking (fail2ban / CrowdSec).** Useful for shedding *repeat* offenders at the
  kernel firewall and cutting log noise, but a *next* layer — the nginx rules plus the app's
  per-IP limiter already absorb most of the volume. Classic **fail2ban fits this stack poorly**:
  it wants a host log file, but our logs go straight to stdout → Vector → Loki (no file on disk),
  and it's per-IP, so it can't touch the distributed/rotating cloud-IP scanning that dominates the
  traffic. If we adopt dynamic blocking, prefer **CrowdSec** — it reads container logs over the
  Docker socket (no host log file), runs as a Compose service, has decoupled "bouncers"
  (host-firewall / in-nginx / Cloudflare), and ships crowdsourced blocklists that *do* cover
  distributed scanners.
- **Cloudflare (highest-value next move).** Putting the site behind Cloudflare hides the origin
  IP (so raw-IP scanning can be firewalled off entirely), uses edge reputation to handle
  distributed scanners, and edge-caches the static site. It's an infrastructure migration, not a
  code change, with prerequisites worth planning for:
  1. **DNS / certs.** The proxy requires Cloudflare to serve the proxied records, which breaks the
     current acme.sh **Gandi DNS-01** wildcard issuance (see [Obtain a wildcard TLS
     certificate](#5-obtain-a-wildcard-tls-certificate)). Switch to Cloudflare's DNS-01 plugin, or
     use a Cloudflare **Origin CA** cert on the origin with SSL mode **Full (strict)**.
  2. **Real client IP.** Once proxied, nginx sees Cloudflare's IP. Add `set_real_ip_from <CF
     ranges>` + `real_ip_header CF-Connecting-IP` (realip module) so the rate limits **and** the
     API's `X-Forwarded-For` logic still see the true client — otherwise every visitor collapses
     to a handful of Cloudflare IPs and both limiters misbehave.
  3. **Origin lockdown.** Restrict the host firewall to Cloudflare's IP ranges, or scanners simply
     hit the raw IP and bypass the edge.
  4. **API subdomain.** Disable caching for `api.govql.us` (dynamic GraphQL); Cloudflare's free
     100s edge timeout is fine against the 30s `proxy_read_timeout`.

  The free tier covers DDoS mitigation, Bot Fight Mode, a few custom WAF rules, and one basic
  rate-limiting rule; the managed OWASP ruleset requires a paid plan.
