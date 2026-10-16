const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // Characterize the zero-elapsed rows
  const zero = await db.raw(`
    SELECT
      mailbox_address, status, threshold_minutes,
      business_minutes_elapsed,
      inbound_at::date AS inbound_date,
      replied_at::date AS replied_date,
      (replied_at - inbound_at) AS wall_clock_diff
    FROM google_reply_latency_records
    WHERE business_minutes_elapsed <= 0
    ORDER BY inbound_at DESC
    LIMIT 10
  `);
  console.log('=== ZERO-ELAPSED SAMPLE (top 10) ===');
  zero.rows.forEach(r =>
    console.log('  ' + r.mailbox_address +
      ' | status=' + r.status +
      ' | biz_min=' + r.business_minutes_elapsed +
      ' | threshold=' + r.threshold_minutes +
      ' | inbound=' + r.inbound_date +
      ' | replied=' + r.replied_date +
      ' | wall_clock_diff=' + r.wall_clock_diff)
  );

  // All zero rows are ON_TIME?
  const byStatus = await db.raw(`
    SELECT status, count(*) AS c
    FROM google_reply_latency_records
    WHERE business_minutes_elapsed <= 0
    GROUP BY status
  `);
  console.log('\n=== ZERO-ELAPSED BY STATUS ===');
  byStatus.rows.forEach(r => console.log('  ' + r.status + ': ' + r.c));

  // Are these same-minute replies (wall clock < 1 minute)?
  const sameminute = await db.raw(`
    SELECT count(*) AS c
    FROM google_reply_latency_records
    WHERE business_minutes_elapsed <= 0
      AND (replied_at - inbound_at) < interval '5 minutes'
  `);
  console.log('\n=== ZERO-ELAPSED WHERE wall_clock < 5 min ===');
  console.log('  count: ' + sameminute.rows[0].c);

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
