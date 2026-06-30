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

# Node.js (needed to build the Docusaurus site)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Create a dedicated user and give it Docker access
adduser --disabled-password --gecos "" govql
usermod -aG docker govql

# Create app directory owned by govql
mkdir -p /opt/govql
chown govql:govql /opt/govql

# Systemd service (runs as govql, not root)
tee /etc/systemd/system/govql.service <<EOF
[Unit]
Description=GovQL
After=docker.service
Requires=docker.service

[Service]
User=govql
WorkingDirectory=/opt/govql/us-congress
ExecStart=dotenvx run -- docker compose up
ExecStop=docker compose down
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable govql

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

### 6. Build the Docusaurus site

```bash
cd /opt/govql/us-congress/docs
npm install
npm run build
```

### 7. Set ENABLE_GRAPHIQL

In `/opt/govql/us-congress/.env`, set:

```
ENABLE_GRAPHIQL=true
```

### 8. Start the stack

```bash
cd /opt/govql/us-congress
dotenvx run -- docker compose up --build -d
```

The API is live at `https://api.govql.us/graphql` and the site at `https://govql.us`.

### 9. Populate the database

The scrapers and ingesters run on cron schedules, so on a fresh deployment you need to trigger the initial run manually:

```bash
# Scrape legislators (clones repo on first run)
docker exec us-congress-scraper-1 /usr/local/bin/update-legislators.sh

# Scrape current session votes
docker exec us-congress-scraper-1 /usr/local/bin/usc-run votes

# Ingest into PostgreSQL (legislators must go first)
docker exec us-congress-ingester-1 sh -c "node /app/src/ingest-legislators.js && node /app/src/ingest-votes.js"
```

## Deploying changes to Docusaurus site

```bash
# Should act as govql user
sudo -u govql -i
```

To get the changes for the site:

```bash
# Make sure we're in the right place
cd /opt/govql/us-congress/docs
# Make sure we're on the main branch
git checkout main
# Pull the latest changes
git pull
```

To deploy changes to the Docusaurus site, simply run the build command and restart the stack:

```bash
cd /opt/govql/us-congress/docs
npm run build
cd /opt/govql/us-congress
# We don't need to rebuild the Docker compose stack, just restart nginx
# We don't even need dotenvx since nginx doesn't need environment variables
docker compose restart nginx
```

## Deploying schema changes

Schema changes ship like any other change — the `flyway` service applies pending migrations on `up`:

```bash
sudo -u govql -i
cd /opt/govql/us-congress
git checkout main && git pull
dotenvx run -- docker compose up -d --build
```

Flyway runs the new `db/migrations/V*.sql`, then the API server restarts and re-introspects the schema. If the change touched documented tables, also rebuild the docs site (see [Deploying changes to Docusaurus site](#deploying-changes-to-docusaurus-site)).

> **First time only:** this production database predates Flyway, so run the one-time `baseline` (see [Adopting Flyway on an existing database](#adopting-flyway-on-an-existing-database-one-time)) **before** the first `up` that includes the `flyway` service — otherwise Flyway would try to recreate the existing schema and fail.

> **502 after the deploy?** If the `up` **recreated** the `server` container (e.g. the postgres container was also recreated, which chains a server recreate), nginx may still be proxying to the old container's IP — it resolves the `server` hostname at startup and caches it. The fix is to bounce nginx so it re-resolves:
>
> ```bash
> docker compose restart nginx
> ```
>
> A routine schema-only deploy that merely restarts `server` in place won't usually trigger this; a deploy that *recreates* `server` (container config change, image rebuild, or a postgres recreate) will.
