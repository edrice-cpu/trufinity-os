// PM2 process configuration for the Google Workspace Responsiveness Worker.
//
// This worker evaluates R-01 through R-04 on a configurable polling interval
// (default 15 minutes per rule). All rules are disabled by default and must
// be explicitly enabled in the environment before starting.
//
// Prerequisites before starting:
//   1. Enable at least one rule in the environment:
//        GOOGLE_R01_ENABLED=true   # Unanswered inbound email
//        GOOGLE_R02_ENABLED=true   # Stalled threads (excessive exchanges)
//        GOOGLE_R03_ENABLED=true   # Reply latency outliers
//        GOOGLE_R04_ENABLED=true   # After-hours backlog
//   2. Run all migrations through 027 against the target database.
//   3. Build: npm run build (produces dist/)
//   4. Set GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=DISABLED (default in code)
//      or TEST/PRODUCTION once notification recipients are confirmed.
//
// Confirmed business settings (Daniel, 2026-10-14):
//   GOOGLE_R01_TIMEZONE              = America/Vancouver  (Pacific Time, DST-aware)
//   GOOGLE_R01_BUSINESS_START_HOUR   = 8                 (08:00 Pacific)
//   GOOGLE_R01_BUSINESS_END_HOUR     = 16                (16:30 Pacific)
//   GOOGLE_R01_BUSINESS_END_MINUTE   = 30
//   GOOGLE_R01_THRESHOLD_MINUTES     = 240               (4 business hours)
//   GOOGLE_R02_MESSAGE_COUNT_THRESHOLD = 3               (Condition B)
//   GOOGLE_R02_CONDITION_A_ENABLED   = false             (inactivity detection disabled)
//   GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES = 510           (~1 business day)
//   GOOGLE_R03_MAILBOX_THRESHOLDS    = service@/support@ = 240 min (hardcoded in rule)
//   GOOGLE_R04_GRACE_MINUTES         = 60                (team has 60 min after business open)
//
// Approved mailboxes for responsiveness reporting:
//   GOOGLE_RESPONSIVENESS_MAILBOX_ALLOWLIST = service@trufinity.ca,support@trufinity.ca,billing@trufinity.ca
//
// Start:  pm2 start ecosystem.google-responsiveness.config.cjs --env production
// Stop:   pm2 stop trufinity-google-responsiveness
// Status: pm2 show trufinity-google-responsiveness

module.exports = {
  apps: [{
    name: 'trufinity-google-responsiveness',
    cwd: __dirname,
    script: 'Backend/dist/workers/google-responsiveness.worker.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    // kill_timeout matches QBO CDC: allow up to 15 minutes for an in-flight evaluation to finish.
    kill_timeout: 900000,
    env_production: { NODE_ENV: 'production' },
  }],
};
