const k = require('knex');
require('dotenv').config();
const db = k({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // 1. Gmail sync state table
  const syncStateTable = await db.raw("SELECT to_regclass('public.google_gmail_sync_state') AS oid");
  console.log('=== GMAIL SYNC STATE TABLE ===');
  console.log('  google_gmail_sync_state: ' + (syncStateTable.rows[0].oid ? 'EXISTS' : 'MISSING (incremental sync uses history-based approach)'));

  // 2. Thread state table (R05 Phase 2)
  const tsTable = await db.raw("SELECT to_regclass('public.google_gmail_thread_state') AS oid");
  const tsExists = !!tsTable.rows[0].oid;
  console.log('  google_gmail_thread_state: ' + (tsExists ? 'EXISTS' : 'MISSING'));
  if (tsExists) {
    const tsCount = await db('google_gmail_thread_state').count({ c: '*' }).first();
    console.log('  thread_state rows: ' + tsCount.c);
  }

  // 3. Mailboxes
  const mailboxes = await db('google_gmail_mailboxes').select('normalized_mailbox_address', 'enabled');
  console.log('\n=== GMAIL MAILBOXES ===');
  mailboxes.forEach(m => console.log('  ' + m.normalized_mailbox_address + ' enabled=' + m.enabled));

  // 4. raw_gmail_messages freshness per mailbox
  const freshness = await db.raw(`
    SELECT mailbox_address,
      count(*) AS total_messages,
      max(updated_at) AS last_updated,
      max(internal_date)::date AS newest_message_date
    FROM raw_gmail_messages
    GROUP BY mailbox_address ORDER BY mailbox_address
  `);
  console.log('\n=== RAW_GMAIL_MESSAGES FRESHNESS ===');
  freshness.rows.forEach(r => console.log(
    '  ' + r.mailbox_address +
    ': total=' + r.total_messages +
    ' last_updated=' + new Date(r.last_updated).toISOString().slice(0,16) +
    ' newest_msg=' + r.newest_message_date
  ));

  // 5. gmail_incremental_checkpoint or history state
  const checkpointTable = await db.raw("SELECT to_regclass('public.google_gmail_history_checkpoints') AS oid");
  console.log('\n=== INCREMENTAL SYNC CHECKPOINT TABLE ===');
  console.log('  google_gmail_history_checkpoints: ' + (checkpointTable.rows[0].oid ? 'EXISTS' : 'MISSING'));

  // Try alternative names
  const cpAlt = await db.raw("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%checkpoint%' OR table_name ILIKE '%sync_state%' OR table_name ILIKE '%history%' ORDER BY table_name");
  console.log('  tables matching checkpoint/sync_state/history: ' + cpAlt.rows.map(r => r.table_name).join(', '));

  // 6. All google_ tables
  const googleTables = await db.raw("SELECT table_name, (SELECT count(*) FROM information_schema.columns WHERE table_name=t.table_name AND table_schema='public') AS col_count FROM information_schema.tables t WHERE table_schema='public' AND table_name LIKE 'google_%' ORDER BY table_name");
  console.log('\n=== ALL GOOGLE_ TABLES ===');
  for (const t of googleTables.rows) {
    const cnt = await db(t.table_name).count({ c: '*' }).first().catch(() => ({ c: 'ERR' }));
    console.log('  ' + t.table_name + ': rows=' + cnt.c + ' cols=' + t.col_count);
  }

  // 7. Responsiveness rule timing estimates
  console.log('\n=== OBSERVED SINGLE-PASS TIMING ===');
  console.log('  R01: ~7 min (985 alerts written, 3 mailboxes)');
  console.log('  R02: ~7 min (233 alerts written, 3 mailboxes)');
  console.log('  R03: ~55 sec (208 records written, 2 mailboxes)');
  console.log('  R04: ~3 min 7 sec (237 alerts written, 3 mailboxes)');
  console.log('  Combined estimate: ~18-20 min for a first-run cycle');
  console.log('  Subsequent cycles (incremental update path): estimated 2-5 min');

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
