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

### 1. Create and configure the droplet

Create a 1 GB Droplet running Ubuntu 24.04. Then SSH in and run:

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
```

### 2. Point DNS to the droplet

In your Gandi DNS settings, create A records for both `govql.us` and `api.govql.us`
pointing to the droplet's IP address. Wait for propagation before continuing.

### 3. Obtain a wildcard TLS certificate

```bash
apt install python3-certbot-dns-gandi

mkdir -p /root/.secrets/certbot
tee /root/.secrets/certbot/gandi.ini <<EOF
dns_gandi_api_key = YOUR_GANDI_API_KEY
EOF
chmod 600 /root/.secrets/certbot/gandi.ini

certbot certonly \
  --authenticator dns-gandi \
  --dns-gandi-credentials /root/.secrets/certbot/gandi.ini \
  -d govql.us -d '*.govql.us'
```

### 4. Install dotenvx and clone the repo

```bash
curl -fsS https://dotenvx.sh | sh

git clone https://github.com/nathangross/govql.git /opt/govql
```

### 5. Add secrets to the droplet

Copy your `.env.keys` file to the droplet (never commit this file):

```bash
# Run this locally
scp votes/.env.keys root@YOUR_DROPLET_IP:/opt/govql/votes/.env.keys
```

### 6. Build the Docusaurus site

Run this locally, then copy the build output to the droplet:

```bash
cd docs && npm run build

scp -r build root@YOUR_DROPLET_IP:/opt/govql/docs/build
```

### 7. Set ENABLE_GRAPHIQL

In `votes/.env`, set:

```
ENABLE_GRAPHIQL=true
```

### 8. Start the stack

```bash
cd /opt/govql/votes
dotenvx run -- docker compose up --build -d
```

The API is live at `https://api.govql.us/graphql` and the site at `https://govql.us`.

### 9. Auto-start on reboot

```bash
tee /etc/systemd/system/govql.service <<EOF
[Unit]
Description=GovQL
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/govql/votes
ExecStart=dotenvx run -- docker compose up
ExecStop=docker compose down
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable govql
```

### 10. Certificate renewal

Add to root's crontab (`crontab -e`):

```
0 3 * * * certbot renew --pre-hook "docker compose -f /opt/govql/votes/compose.yml stop nginx" --post-hook "docker compose -f /opt/govql/votes/compose.yml start nginx" --quiet
```
