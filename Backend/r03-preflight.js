const knex = require('knex');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const db = knex({
  client: 'pg',
  connection: {
    host: '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5433'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }
});

async function run() {
  // 1. DB identity
  const id = await db.raw("SELECT current_database() AS dbname, inet_server_addr() AS addr, inet_server_port() AS port");
  const r = id.rows[0];
  console.log('=== DB IDENTITY ===');
  console.log('  dbname: ' + r.dbname);
  console.log('  tunnel_port: ' + parseInt(process.env.DB_PORT || '5433'));
  console.log('  server_addr: ' + r.addr);
  console.log('  server_port: ' + r.port);

  // 2. R03 table existence
  const tableCheck = await db.raw("SELECT to_regclass('public.google_reply_latency_records') AS oid");
  const tableExists = !!tableCheck.rows[0].oid;
  console.log('\n=== R03 TABLE ===');
  console.log('  google_reply_latency_records: ' + (tableExists ? 'EXISTS' : 'MISSING — BLOCKER'));

  if (!tableExists) {
    console.log('\nBLOCKER: table does not exist. Migration required before execution.');
    await db.destroy();
    return;
  }

  // 3. Unique constraints
  const con = await db.raw(`
    SELECT tc.constraint_name, string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS cols
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_name = 'google_reply_latency_records'
    GROUP BY tc.constraint_name
  `);
  console.log('\n=== UNIQUE CONSTRAINTS ===');
  if (con.rows.length === 0) {
    console.log('  NONE — BLOCKER: no idempotency gate');
  } else {
    con.rows.forEach(c => console.log('  [' + c.constraint_name + ']: ' + c.cols));
    const hasR03Key = con.rows.some(c => c.cols.includes('mailbox_address') && c.cols.includes('thread_id') && c.cols.includes('inbound_message_id'));
    console.log('  R03 key (mailbox_address, thread_id, inbound_message_id): ' + (hasR03Key ? 'PRESENT — PASS' : 'MISSING — BLOCKER'));
  }

  // 4. Table columns
  const cols = await db.raw("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='google_reply_latency_records' ORDER BY ordinal_position");
  console.log('\n=== TABLE COLUMNS ===');
  cols.rows.forEach(c => console.log('  ' + c.column_name + ' (' + c.data_type + ')'));

  // 5. Indexes
  const idx = await db.raw("SELECT indexname FROM pg_indexes WHERE tablename='google_reply_latency_records' ORDER BY indexname");
  console.log('\n=== INDEXES ===');
  if (idx.rows.length === 0) console.log('  (none)');
  else idx.rows.forEach(i => console.log('  ' + i.indexname));

  // 6. Mailbox eligibility — approved mailboxes in DB
  console.log('\n=== MAILBOX ELIGIBILITY ===');
  const approvedMailboxes = ['service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca'];
  // R03 excludes billing per rule config; service and support are eligible
  const r03Excluded = ['billing@trufinity.ca', 'careers@trufinity.ca', 'info@trufinity.ca'];
  for (const m of approvedMailboxes) {
    const mb = await db('google_gmail_mailboxes').where({ normalized_mailbox_address: m }).first();
    const excluded = r03Excluded.includes(m);
    const status = excluded ? 'EXCLUDED_BY_RULE' : (mb ? ('enabled=' + mb.enabled) : 'NOT_FOUND');
    console.log('  ' + m + ': ' + status);
  }

  // 7. source data — raw_gmail_messages stats for eligible mailboxes
  console.log('\n=== RAW_GMAIL_MESSAGES SOURCE DATA ===');
  const r03EligibleMailboxes = ['service@trufinity.ca', 'support@trufinity.ca'];
  for (const m of r03EligibleMailboxes) {
    const stats = await db.raw(`
      SELECT
        count(*) AS total_messages,
        count(*) FILTER (WHERE is_latest = true AND is_deleted = false) AS current_messages,
        min(internal_date)::date AS oldest_date,
        max(internal_date)::date AS newest_date
      FROM raw_gmail_messages
      WHERE mailbox_address = ?
    `, [m]);
    const s = stats.rows[0];
    console.log('  ' + m + ': total=' + s.total_messages + ' current=' + s.current_messages + ' range=' + s.oldest_date + ' to ' + s.newest_date);
  }

  // 8. Before-execution counts — all R tables
  console.log('\n=== BEFORE-EXECUTION COUNTS ===');
  const r01 = await db('google_unanswered_thread_alerts').count({ c: '*' }).first();
  const r02 = await db('google_stalled_thread_alerts').count({ c: '*' }).first();
  const r03 = await db('google_reply_latency_records').count({ c: '*' }).first();
  const r04 = await db('google_after_hours_backlog_alerts').count({ c: '*' }).first();
  const notif = await db('google_responsiveness_notifications').count({ c: '*' }).first();
  console.log('  google_unanswered_thread_alerts (R01): ' + r01.c + ' (expected 985)');
  console.log('  google_stalled_thread_alerts (R02):    ' + r02.c + ' (expected 233)');
  console.log('  google_reply_latency_records (R03):    ' + r03.c + ' (expected 0)');
  console.log('  google_after_hours_backlog_alerts (R04): ' + r04.c + ' (expected 0)');
  console.log('  google_responsiveness_notifications:   ' + notif.c + ' (expected 0)');
  const r01Check = r01.c == '985' ? 'PASS' : 'CHANGED (was 985)';
  const r02Check = r02.c == '233' ? 'PASS' : 'CHANGED (was 233)';
  console.log('  R01 baseline check: ' + r01Check);
  console.log('  R02 baseline check: ' + r02Check);

  // 9. Advisory lock
  const tryLock = await db.raw("SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS acquired");
  const acquired = tryLock.rows[0].acquired;
  console.log('\n=== ADVISORY LOCK ===');
  console.log('  acquirable: ' + acquired + (acquired ? ' — PASS (no overlap)' : ' — BLOCKED'));
  if (acquired) {
    await db.raw("SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))");
    console.log('  released: true');
  }

  // 10. Notification safety — check notification mode env
  const notifMode = process.env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE || '(not set)';
  console.log('\n=== NOTIFICATION MODE ===');
  console.log('  GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE: ' + notifMode);
  console.log('  safe for controlled run: ' + (notifMode === 'DISABLED' ? 'YES — PASS' : 'NO — requires DISABLED'));

  // 11. Lookback window confirmation
  const r03LookbackDays = parseInt(process.env.GOOGLE_R03_LOOKBACK_DAYS || '30');
  const r03DefaultThreshold = parseInt(process.env.GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES || '510');
  const cutoffDate = new Date(Date.now() - r03LookbackDays * 24 * 60 * 60 * 1000);
  console.log('\n=== R03 CONFIGURATION ===');
  console.log('  GOOGLE_R03_ENABLED: ' + (process.env.GOOGLE_R03_ENABLED || '(not set, default=false)'));
  console.log('  GOOGLE_R03_LOOKBACK_DAYS: ' + r03LookbackDays + ' → cutoff ' + cutoffDate.toISOString().split('T')[0]);
  console.log('  GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES: ' + r03DefaultThreshold + ' min');
  console.log('  service@ threshold (hardcoded): 240 min');
  console.log('  support@ threshold (hardcoded): 240 min');
  console.log('  billing@ disposition: EXCLUDED_BY_RULE (not processed)');

  // 12. Estimate scope — messages in lookback window for eligible mailboxes
  console.log('\n=== LOOKBACK SCOPE ESTIMATE ===');
  for (const m of r03EligibleMailboxes) {
    const inWindow = await db.raw(`
      SELECT count(DISTINCT thread_id) AS threads, count(*) AS messages
      FROM raw_gmail_messages
      WHERE mailbox_address = ? AND is_latest = true AND is_deleted = false AND internal_date >= ?
    `, [m, cutoffDate]);
    const s = inWindow.rows[0];
    console.log('  ' + m + ': threads_in_window=' + s.threads + ' messages_in_window=' + s.messages);
  }

  await db.destroy();
}

run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
