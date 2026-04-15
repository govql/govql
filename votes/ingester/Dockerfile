FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY ingest_cron /etc/cron.d/ingest_cron
RUN chmod 0644 /etc/cron.d/ingest_cron && crontab /etc/cron.d/ingest_cron

COPY src/ ./src/

RUN mkdir -p /var/log

# busybox crond (already in Alpine) runs in foreground with -f.
# printenv saves the container's env vars so cron jobs can source them.
CMD ["/bin/sh", "-c", "printenv > /etc/environment && crond -f"]
