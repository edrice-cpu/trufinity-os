const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // 1. R03 totals
  const total = await db('google_reply_latency_records').count({ c: '*' }).first();
  console.log('=== R03 TOTALS ===');
  console.log('  total_rows: ' + total.c);

  // 2. Breakdown by mailbox + status
  const breakdown = await db.raw(`
    SELECT mailbox_address, status, count(*) AS c,
      round(avg(business_minutes_elapsed)) AS avg_biz_min,
      min(business_minutes_elapsed) AS min_biz_min,
      max(business_minutes_elapsed) AS max_biz_min,
      min(threshold_minutes) AS threshold
    FROM google_reply_latency_records
    GROUP BY mailbox_address, status
    ORDER BY mailbox_address, status
  `);
  console.log('\n=== R03 BREAKDOWN (mailbox / status) ===');
  if (breakdown.rows.length === 0) console.log('  (empty)');
  else breakdown.rows.forEach(r =>
    console.log('  ' + r.mailbox_address + ' | ' + r.status +
      ' | count=' + r.c +
      ' | avg_biz_min=' + r.avg_biz_min +
      ' | min=' + r.min_biz_min +
      ' | max=' + r.max_biz_min +
      ' | threshold=' + r.threshold)
  );

  // 3. Duplicate detection
  const dupes = await db.raw(`
    SELECT mailbox_address, thread_id, inbound_message_id, count(*) AS c
    FROM google_reply_latency_records
    GROUP BY mailbox_address, thread_id, inbound_message_id
    HAVING count(*) > 1
  `);
  console.log('\n=== DUPLICATE CHECK ===');
  console.log('  duplicate (mailbox, thread_id, inbound_message_id) groups: ' + dupes.rows.length +
    (dupes.rows.length === 0 ? ' — PASS' : ' — FAIL'));

  // 4. Non-approved / excluded mailbox check
  const nonApproved = await db.raw(`
    SELECT mailbox_address, count(*) AS c
    FROM google_reply_latency_records
    WHERE mailbox_address NOT IN ('service@trufinity.ca','support@trufinity.ca')
    GROUP BY mailbox_address
  `);
  console.log('\n=== EXCLUDED MAILBOX CHECK ===');
  console.log('  rows for billing@/careers@/other: ' + nonApproved.rows.length +
    (nonApproved.rows.length === 0 ? ' — PASS' : ' — FAIL'));
  if (nonApproved.rows.length > 0) nonApproved.rows.forEach(r => console.log('  UNEXPECTED: ' + r.mailbox_address + ' count=' + r.c));

  // 5. Threshold consistency
  const wrongThreshold = await db.raw(`
    SELECT mailbox_address, threshold_minutes, count(*) AS c
    FROM google_reply_latency_records
    WHERE (mailbox_address IN ('service@trufinity.ca','support@trufinity.ca') AND threshold_minutes != 240)
       OR (mailbox_address NOT IN ('service@trufinity.ca','support@trufinity.ca') AND threshold_minutes != 510)
    GROUP BY mailbox_address, threshold_minutes
  `);
  console.log('\n=== THRESHOLD CONSISTENCY ===');
  console.log('  rows with wrong threshold: ' + wrongThreshold.rows.length +
    (wrongThreshold.rows.length === 0 ? ' — PASS' : ' — FAIL'));

  // 6. R01/R02 unchanged
  const r01 = await db('google_unanswered_thread_alerts').count({ c: '*' }).first();
  const r02 = await db('google_stalled_thread_alerts').count({ c: '*' }).first();
  console.log('\n=== R01 / R02 UNCHANGED ===');
  console.log('  R01 total: ' + r01.c + (r01.c == '985' ? ' — PASS' : ' — CHANGED (was 985)'));
  console.log('  R02 total: ' + r02.c + (r02.c == '233' ? ' — PASS' : ' — CHANGED (was 233)'));

  // 7. R04 and notifications at zero
  const r04 = await db('google_after_hours_backlog_alerts').count({ c: '*' }).first();
  const notif = await db('google_responsiveness_notifications').count({ c: '*' }).first();
  console.log('\n=== R04 / NOTIFICATIONS UNCHANGED ===');
  console.log('  R04 total: ' + r04.c + (r04.c == '0' ? ' — PASS' : ' — CHANGED'));
  console.log('  notifications: ' + notif.c + (notif.c == '0' ? ' — PASS' : ' — CHANGED'));

  // 8. Advisory lock released
  const lk = await db.raw("SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS a");
  const a = lk.rows[0].a;
  console.log('\n=== ADVISORY LOCK RELEASED ===');
  console.log('  acquirable: ' + a + (a ? ' — PASS (lock free)' : ' — FAIL (still held)'));
  if (a) {
    await db.raw("SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))");
    console.log('  released: true');
  }

  // 9. Sample LATE rows (newest 6, no message content)
  const sample = await db.raw(`
    SELECT mailbox_address, status, business_minutes_elapsed, threshold_minutes,
           inbound_at::date AS inbound_date, replied_at::date AS replied_date,
           created_at::date AS created_date
    FROM google_reply_latency_records
    WHERE status = 'LATE'
    ORDER BY business_minutes_elapsed DESC
    LIMIT 6
  `);
  console.log('\n=== LATE SAMPLE (top 6 by elapsed, no message content) ===');
  if (sample.rows.length === 0) console.log('  (none)');
  else sample.rows.forEach(r =>
    console.log('  ' + r.mailbox_address +
      ' | status=' + r.status +
      ' | biz_min=' + r.business_minutes_elapsed +
      ' | threshold=' + r.threshold_minutes +
      ' | inbound=' + r.inbound_date +
      ' | replied=' + r.replied_date)
  );

  // 10. business_minutes_elapsed sanity — no negative or zero values
  const invalid = await db('google_reply_latency_records')
    .where(db.raw('business_minutes_elapsed <= 0'))
    .count({ c: '*' }).first();
  console.log('\n=== ELAPSED SANITY (no zero/negative) ===');
  console.log('  rows with elapsed <= 0: ' + invalid.c + (invalid.c == '0' ? ' — PASS' : ' — UNEXPECTED'));

  await db.destroy();
}

run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
