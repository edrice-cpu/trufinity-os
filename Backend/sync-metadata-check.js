const k = require('knex');
require('dotenv').config();
const db = k({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });
async function run() {
  // Check raw_gmail_sync_metadata
  const smTable = await db.raw("SELECT to_regclass('public.raw_gmail_sync_metadata') AS oid");
  console.log('raw_gmail_sync_metadata: ' + (smTable.rows[0].oid ? 'EXISTS' : 'MISSING'));
  if (smTable.rows[0].oid) {
    const rows = await db('raw_gmail_sync_metadata').select('mailbox_id', 'history_id', 'last_successful_history_id', 'last_successful_sync_at').orderBy('last_successful_sync_at', 'desc');
    console.log('checkpoint rows: ' + rows.length);
    rows.slice(0, 5).forEach(r => console.log('  mailbox_id=' + r.mailbox_id + ' history_id=' + r.history_id + ' last_sync=' + (r.last_successful_sync_at ? new Date(r.last_successful_sync_at).toISOString().slice(0,16) : 'null')));
    const withHistoryId = rows.filter(r => r.history_id);
    console.log('mailboxes with history_id (incremental sync ready): ' + withHistoryId.length + '/' + rows.length);
    const nullHistoryId = rows.filter(r => !r.history_id);
    if (nullHistoryId.length > 0) console.log('mailboxes with null history_id (historical sync incomplete): ' + nullHistoryId.length);
  }
  // notification count check
  const notif = await db('google_responsiveness_notifications').count({ c: '*' }).first();
  console.log('\nnotifications: ' + notif.c);
  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
