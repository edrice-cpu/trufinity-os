const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // 1. R04 totals
  const total = await db('google_after_hours_backlog_alerts').count({ c: '*' }).first();
  console.log('=== R04 TOTALS ===');
  console.log('  total_rows: ' + total.c);

  // 2. Breakdown by mailbox + status
  const breakdown = await db.raw(`
    SELECT mailbox_address, status, count(*) AS c,
      min(inbound_at)::date AS oldest_inbound,
      max(inbound_at)::date AS newest_inbound,
      min(deadline_at)::date AS earliest_deadline,
      max(deadline_at)::date AS latest_deadline
    FROM google_after_hours_backlog_alerts
    GROUP BY mailbox_address, status
    ORDER BY mailbox_address, status
  `);
  console.log('\n=== BREAKDOWN (mailbox / status) ===');
  if (breakdown.rows.length === 0) console.log('  (empty)');
  else breakdown.rows.forEach(r =>
    console.log('  ' + r.mailbox_address + ' | ' + r.status +
      ' | count=' + r.c +
      ' | inbound_range=' + r.oldest_inbound + ' to ' + r.newest_inbound +
      ' | deadline_range=' + r.earliest_deadline + ' to ' + r.latest_deadline)
  );

  // 3. Duplicate detection
  const dupes = await db.raw(`
    SELECT mailbox_address, thread_id, inbound_message_id, count(*) AS c
    FROM google_after_hours_backlog_alerts
    GROUP BY mailbox_address, thread_id, inbound_message_id
    HAVING count(*) > 1
  `);
  console.log('\n=== DUPLICATE CHECK ===');
  console.log('  duplicate (mailbox, thread, inbound_msg) groups: ' + dupes.rows.length +
    (dupes.rows.length === 0 ? ' — PASS' : ' — FAIL'));

  // 4. Non-approved mailbox check
  const nonApproved = await db.raw(`
    SELECT mailbox_address, count(*) AS c
    FROM google_after_hours_backlog_alerts
    WHERE mailbox_address NOT IN ('service@trufinity.ca','support@trufinity.ca','billing@trufinity.ca')
    GROUP BY mailbox_address
  `);
  console.log('\n=== NON-APPROVED MAILBOX CHECK ===');
  console.log('  violations: ' + nonApproved.rows.length +
    (nonApproved.rows.length === 0 ? ' — PASS' : ' — FAIL'));
  if (nonApproved.rows.length > 0) nonApproved.rows.forEach(r => console.log('  UNEXPECTED: ' + r.mailbox_address + ' count=' + r.c));

  // 5. Grace deadline sanity — deadline_at should be > inbound_at
  const badDeadline = await db.raw(`
    SELECT count(*) AS c FROM google_after_hours_backlog_alerts WHERE deadline_at <= inbound_at
  `);
  console.log('\n=== GRACE DEADLINE SANITY (deadline > inbound) ===');
  console.log('  rows where deadline <= inbound: ' + badDeadline.rows[0].c +
    (badDeadline.rows[0].c == '0' ? ' — PASS' : ' — FAIL'));

  // 6. Deadline gap — confirm deadline_at reflects next_business_open + 60 min
  //    Sample: check a few rows where deadline is on a Monday (likely Fri/Sat/Sun inbound)
  const mondayDeadlines = await db.raw(`
    SELECT mailbox_address, status,
      inbound_at::date AS inbound_date,
      to_char(inbound_at AT TIME ZONE 'America/Vancouver', 'Dy HH24:MI') AS inbound_local,
      deadline_at::date AS deadline_date,
      to_char(deadline_at AT TIME ZONE 'America/Vancouver', 'Dy HH24:MI') AS deadline_local
    FROM google_after_hours_backlog_alerts
    WHERE EXTRACT(DOW FROM deadline_at AT TIME ZONE 'America/Vancouver') = 1
    ORDER BY inbound_at DESC
    LIMIT 5
  `);
  console.log('\n=== SAMPLE: MONDAY DEADLINES (weekend/Friday inbounds) ===');
  if (mondayDeadlines.rows.length === 0) console.log('  (none — all deadlines on weekdays)');
  else mondayDeadlines.rows.forEach(r =>
    console.log('  mailbox=' + r.mailbox_address.split('@')[0] +
      ' | inbound=' + r.inbound_local + ' (' + r.inbound_date + ')' +
      ' | deadline=' + r.deadline_local + ' (' + r.deadline_date + ')')
  );

  // 7. Sample OPEN rows (no message content)
  const sample = await db.raw(`
    SELECT mailbox_address, status,
      inbound_at::date AS inbound_date,
      to_char(inbound_at AT TIME ZONE 'America/Vancouver', 'Dy HH24:MI') AS inbound_local,
      deadline_at::date AS deadline_date,
      to_char(deadline_at AT TIME ZONE 'America/Vancouver', 'Dy HH24:MI') AS deadline_local,
      notification_generation
    FROM google_after_hours_backlog_alerts
    WHERE status = 'OPEN'
    ORDER BY inbound_at DESC
    LIMIT 6
  `);
  console.log('\n=== OPEN SAMPLE (newest 6, no message content) ===');
  sample.rows.forEach(r =>
    console.log('  ' + r.mailbox_address.split('@')[0] +
      ' | inbound=' + r.inbound_local + ' (' + r.inbound_date + ')' +
      ' | deadline=' + r.deadline_local + ' (' + r.deadline_date + ')' +
      ' | notif_gen=' + r.notification_generation)
  );

  // 8. notification_generation values — all should be 0 on first insert
  const notifGenCheck = await db.raw(`
    SELECT notification_generation, count(*) AS c
    FROM google_after_hours_backlog_alerts
    GROUP BY notification_generation ORDER BY notification_generation
  `);
  console.log('\n=== NOTIFICATION_GENERATION DISTRIBUTION ===');
  notifGenCheck.rows.forEach(r => console.log('  gen=' + r.notification_generation + ': count=' + r.c));
  const allZero = notifGenCheck.rows.every(r => r.notification_generation == 0);
  console.log('  all_zero: ' + allZero + (allZero ? ' — PASS (first run)' : ' — some non-zero (re-open cycles)'));

  // 9. R01/R02/R03 unchanged
  const r01 = await db('google_unanswered_thread_alerts').count({ c: '*' }).first();
  const r02 = await db('google_stalled_thread_alerts').count({ c: '*' }).first();
  const r03 = await db('google_reply_latency_records').count({ c: '*' }).first();
  console.log('\n=== R01/R02/R03 UNCHANGED ===');
  console.log('  R01: ' + r01.c + (r01.c == '985' ? ' — PASS' : ' — CHANGED (was 985)'));
  console.log('  R02: ' + r02.c + (r02.c == '233' ? ' — PASS' : ' — CHANGED (was 233)'));
  console.log('  R03: ' + r03.c + (r03.c == '208' ? ' — PASS' : ' — CHANGED (was 208)'));

  // 10. Notifications unchanged
  const notif = await db('google_responsiveness_notifications').count({ c: '*' }).first();
  console.log('\n=== NOTIFICATIONS UNCHANGED ===');
  console.log('  notifications: ' + notif.c + (notif.c == '0' ? ' — PASS' : ' — CHANGED'));

  // 11. Advisory lock released
  const lk = await db.raw("SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS a");
  const a = lk.rows[0].a;
  console.log('\n=== ADVISORY LOCK RELEASED ===');
  console.log('  acquirable: ' + a + (a ? ' — PASS (lock free)' : ' — FAIL (still held)'));
  if (a) {
    await db.raw("SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))");
    console.log('  released: true');
  }

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
