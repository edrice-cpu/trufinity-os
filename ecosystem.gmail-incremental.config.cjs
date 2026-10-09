// PM2 process configuration for the Gmail Incremental Sync Worker.
//
// This worker polls all enabled Gmail mailboxes on a configurable interval
// (GOOGLE_GMAIL_SYNC_INTERVAL_MS, default 15 minutes), and at the start of
// each cycle runs recoverPendingNotifications() to retry any work-item
// notification deliveries that failed or were interrupted in a previous cycle.
//
// Prerequisites before starting:
//   1. Run migrations 017 and 018 against the target database
//   2. Ensure Google service-account credentials are set in the environment
//      (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
//       GOOGLE_ADMIN_DELEGATED_USER)
//   3. Set WORK_ITEM_NOTIFICATION_RECIPIENT if SMTP notifications are required
//   4. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM if SMTP is enabled
//   5. Build: npm run build (produces dist/)
//
// Start:  pm2 start ecosystem.gmail-incremental.config.cjs --env production
// Stop:   pm2 stop trufinity-gmail-incremental
// Status: pm2 show trufinity-gmail-incremental

module.exports = {
  apps: [{
    name: 'trufinity-gmail-incremental',
    cwd: __dirname,
    script: 'Backend/dist/workers/gmail-incremental.worker.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    // kill_timeout: allow up to 15 minutes for an in-flight mailbox sync to finish
    // before PM2 sends SIGKILL. Mirrors the QBO CDC and responsiveness worker settings.
    kill_timeout: 900000,
    env_production: { NODE_ENV: 'production' },
  }],
};
