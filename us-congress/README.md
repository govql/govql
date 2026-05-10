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
