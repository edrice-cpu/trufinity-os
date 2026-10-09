// PM2 process configuration for the Google Workspace Responsiveness Worker.
//
// This worker evaluates R-01 (unanswered inbound email) and future rules
// R-02–R-05 on a configurable polling interval.
//
// Prerequisites before starting:
//   1. Set GOOGLE_R01_ENABLED=true in the environment (default: false / disabled)
//   2. Confirm product thresholds (GOOGLE_R01_THRESHOLD_MINUTES, GOOGLE_R01_TIMEZONE,
//      GOOGLE_R01_BUSINESS_START_HOUR, GOOGLE_R01_BUSINESS_END_HOUR)
//   3. Run migrations 017, 018, 019 against the target database
//   4. Build: npm run build (produces dist/)
//
// ⚠ Default values in env.ts are UNCONFIRMED PLACEHOLDERS:
//   GOOGLE_R01_THRESHOLD_MINUTES = 240 (4 business hours) — awaiting product confirmation
//   GOOGLE_R01_TIMEZONE           = America/Toronto       — awaiting operator confirmation
//   GOOGLE_R01_BUSINESS_START_HOUR = 9                   — awaiting operator confirmation
//   GOOGLE_R01_BUSINESS_END_HOUR   = 17                  — awaiting operator confirmation
//
// DO NOT start this process until all confirmations are in place.
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
