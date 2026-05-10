// Minimal structured logger for cron-based ingestion scripts.
// Prefixes every line with an ISO timestamp and level so log aggregators can
// parse entries from the /var/log/ingest.log output.

function fmt(level, msg) {
  return `[${new Date().toISOString()}] ${level} ${msg}`;
}

export const logger = {
  info:  (msg) => console.log(fmt('INFO ', msg)),
  warn:  (msg) => console.warn(fmt('WARN ', msg)),
  error: (msg) => console.error(fmt('ERROR', msg)),
};
