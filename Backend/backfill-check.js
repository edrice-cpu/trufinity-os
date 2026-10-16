const k = require('knex');
require('dotenv').config();
const db = k({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });
async function run() {
  const row = await db('google_gmail_thread_state_backfill').first();
  console.log('thread_state_backfill row: ' + JSON.stringify(row));
  const cols = await db.raw('SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position', ['google_gmail_thread_state_backfill']);
  console.log('columns: ' + cols.rows.map(r => r.column_name).join(', '));

  // Also check env R05 flag
  console.log('GOOGLE_R01_LOOKBACK_DAYS: ' + (process.env.GOOGLE_R01_LOOKBACK_DAYS || '30 (default)'));
  console.log('useThreadState in routes: hardcoded true');
  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
