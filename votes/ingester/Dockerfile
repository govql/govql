FROM node:22-alpine

RUN apk add --no-cache cron

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY ingest_cron /etc/cron.d/ingest_cron
RUN chmod 0644 /etc/cron.d/ingest_cron && crontab /etc/cron.d/ingest_cron

COPY src/ ./src/

RUN mkdir -p /var/log

# Save container env vars to /etc/environment at startup so cron jobs can
# source them (cron does not inherit the parent process environment).
CMD ["/bin/sh", "-c", "printenv > /etc/environment && cron -f"]
