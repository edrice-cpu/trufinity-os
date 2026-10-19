const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // 1. DB identity
  const id = await db.raw("SELECT current_database() AS d, inet_server_addr() AS addr, inet_server_port() AS p");
  const r = id.rows[0];
  console.log('=== DB IDENTITY ===');
  console.log('  dbname: ' + r.d);
  console.log('  tunnel_port: ' + parseInt(process.env.DB_PORT||'5433'));
  console.log('  server_addr: ' + r.addr);
  console.log('  server_port: ' + r.p);

  // 2. R04 table existence
  const tableCheck = await db.raw("SELECT to_regclass('public.google_after_hours_backlog_alerts') AS oid");
  const tableExists = !!tableCheck.rows[0].oid;
  console.log('\n=== R04 TABLE ===');
  console.log('  google_after_hours_backlog_alerts: ' + (tableExists ? 'EXISTS' : 'MISSING — BLOCKER'));
  if (!tableExists) { await db.destroy(); return; }

  // 3. Columns
  const cols = await db.raw("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='google_after_hours_backlog_alerts' ORDER BY ordinal_position");
  console.log('\n=== TABLE COLUMNS ===');
  cols.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));

  // 4. Unique constraints
  const con = await db.raw(`
    SELECT tc.constraint_name, string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS cols
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_name = 'google_after_hours_backlog_alerts'
    GROUP BY tc.constraint_name
  `);
  console.log('\n=== UNIQUE CONSTRAINTS ===');
  if (con.rows.length === 0) console.log('  NONE — BLOCKER');
  else {
    con.rows.forEach(c => console.log('  [' + c.constraint_name + ']: ' + c.cols));
    const hasKey = con.rows.some(c => c.cols.includes('mailbox_address') && c.cols.includes('thread_id') && c.cols.includes('inbound_message_id'));
    console.log('  R04 idempotency key (mailbox, thread, inbound_msg): ' + (hasKey ? 'PRESENT — PASS' : 'MISSING — BLOCKER'));
  }

  // 5. Indexes
  const idx = await db.raw("SELECT indexname FROM pg_indexes WHERE tablename='google_after_hours_backlog_alerts' ORDER BY indexname");
  console.log('\n=== INDEXES ===');
  if (idx.rows.length === 0) console.log('  (none)');
  else idx.rows.forEach(i => console.log('  ' + i.indexname));

  // 6. Mailbox eligibility
  console.log('\n=== MAILBOX ELIGIBILITY ===');
  // R04 has no excluded mailboxes in the rule — all approved mailboxes are eligible
  for (const m of ['service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca']) {
    const mb = await db('google_gmail_mailboxes').where({ normalized_mailbox_address: m }).first();
    console.log('  ' + m + ': ' + (mb ? 'enabled=' + mb.enabled : 'NOT_FOUND'));
  }

  // 7. Baseline counts
  console.log('\n=== BASELINE COUNTS ===');
  const r01 = await db('google_unanswered_thread_alerts').count({ c: '*' }).first();
  const r02 = await db('google_stalled_thread_alerts').count({ c: '*' }).first();
  const r03 = await db('google_reply_latency_records').count({ c: '*' }).first();
  const r04 = await db('google_after_hours_backlog_alerts').count({ c: '*' }).first();
  const notif = await db('google_responsiveness_notifications').count({ c: '*' }).first();
  console.log('  R01 google_unanswered_thread_alerts: ' + r01.c + (r01.c == '985' ? ' — PASS' : ' — CHANGED (was 985)'));
  console.log('  R02 google_stalled_thread_alerts:    ' + r02.c + (r02.c == '233' ? ' — PASS' : ' — CHANGED (was 233)'));
  console.log('  R03 google_reply_latency_records:    ' + r03.c + (r03.c == '208' ? ' — PASS' : ' — CHANGED (was 208)'));
  console.log('  R04 google_after_hours_backlog_alerts: ' + r04.c + (r04.c == '0' ? ' — PASS (clean slate)' : ' — HAS EXISTING ROWS'));
  console.log('  notifications:                       ' + notif.c + (notif.c == '0' ? ' — PASS' : ' — CHANGED'));

  // 8. Advisory lock
  const lk = await db.raw("SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS a");
  const a = lk.rows[0].a;
  console.log('\n=== ADVISORY LOCK ===');
  console.log('  acquirable: ' + a + (a ? ' — PASS' : ' — BLOCKED'));
  if (a) {
    await db.raw("SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))");
    console.log('  released: true');
  }

  // 9. Notification mode
  const nm = process.env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE || '(not set)';
  console.log('\n=== NOTIFICATION MODE ===');
  console.log('  env value: ' + nm);
  console.log('  safe for controlled run: ' + (nm === 'DISABLED' ? 'YES — PASS' : 'needs override to DISABLED'));

  // 10. R04 config from env
  const lookbackDays = parseInt(process.env.GOOGLE_R04_LOOKBACK_DAYS || '30');
  const graceMinutes = parseInt(process.env.GOOGLE_R04_GRACE_MINUTES || '60');
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  console.log('\n=== R04 CONFIGURATION ===');
  console.log('  GOOGLE_R04_ENABLED: ' + (process.env.GOOGLE_R04_ENABLED || '(not set, default=false)'));
  console.log('  GOOGLE_R04_LOOKBACK_DAYS: ' + lookbackDays + ' → cutoff ' + cutoff.toISOString().split('T')[0]);
  console.log('  GOOGLE_R04_GRACE_MINUTES: ' + graceMinutes + ' min');
  console.log('  after_hours_windows (hardcoded):');
  console.log('    Mon-Fri 16:30-22:00 Pacific');
  console.log('    Sat-Sun 07:00-22:00 Pacific');
  console.log('  business_calendar.timezone: America/Vancouver (DST-aware)');
  console.log('  grace_deadline: next_business_open + ' + graceMinutes + ' min');

  // 11. Scope estimate — raw_gmail_messages in lookback window per approved mailbox
  console.log('\n=== LOOKBACK SCOPE ESTIMATE ===');
  for (const m of ['service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca']) {
    const s = await db.raw(`
      SELECT count(DISTINCT thread_id) AS threads, count(*) AS messages
      FROM raw_gmail_messages
      WHERE mailbox_address = ? AND is_latest = true AND is_deleted = false AND internal_date >= ?
    `, [m, cutoff]);
    const row = s.rows[0];
    console.log('  ' + m + ': threads=' + row.threads + ' messages=' + row.messages);
  }

  // 12. Performance: check index on raw_gmail_messages for lookback filter
  const rmIdx = await db.raw("SELECT indexname, indexdef FROM pg_indexes WHERE tablename='raw_gmail_messages' AND (indexdef ILIKE '%internal_date%' OR indexdef ILIKE '%mailbox_address%') ORDER BY indexname");
  console.log('\n=== RAW_GMAIL_MESSAGES INDEXES (relevant to R04 query) ===');
  if (rmIdx.rows.length === 0) console.log('  (none found — may be full scan)');
  else rmIdx.rows.forEach(i => console.log('  ' + i.indexname));

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
