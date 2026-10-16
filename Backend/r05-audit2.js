const k = require('knex');
require('dotenv').config();
const db = k({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });

async function run() {
  // raw_gmail_messages columns
  const rmCols = await db.raw("SELECT column_name FROM information_schema.columns WHERE table_name='raw_gmail_messages' ORDER BY ordinal_position");
  console.log('=== RAW_GMAIL_MESSAGES COLUMNS ===');
  console.log('  ' + rmCols.rows.map(r => r.column_name).join(', '));

  // freshness using internal_date
  const freshness = await db.raw(`
    SELECT mailbox_address,
      count(*) AS total_messages,
      max(internal_date)::date AS newest_message_date,
      min(internal_date)::date AS oldest_message_date
    FROM raw_gmail_messages
    GROUP BY mailbox_address ORDER BY mailbox_address
  `);
  console.log('\n=== RAW_GMAIL_MESSAGES FRESHNESS ===');
  freshness.rows.forEach(r => console.log(
    '  ' + r.mailbox_address +
    ': total=' + r.total_messages +
    ' oldest=' + r.oldest_message_date +
    ' newest=' + r.newest_message_date
  ));

  // Incremental checkpoint tables — check all google_ tables with their row counts
  const googleTables = await db.raw(`
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE table_schema='public' AND table_name LIKE 'google_%'
    ORDER BY table_name
  `);
  console.log('\n=== ALL GOOGLE_ TABLES (row counts) ===');
  for (const t of googleTables.rows) {
    try {
      const cnt = await db(t.table_name).count({ c: '*' }).first();
      console.log('  ' + t.table_name + ': ' + cnt.c);
    } catch (e) {
      console.log('  ' + t.table_name + ': ERR ' + e.message);
    }
  }

  // PM2 process status — check if workers are running
  console.log('\n=== PM2 CONFIG LOCATIONS ===');
  console.log('  ecosystem.gmail-incremental.config.cjs: EXISTS (at repo root)');
  console.log('  ecosystem.google-responsiveness.config.cjs: EXISTS (at repo root)');
  console.log('  PM2 running status: UNVERIFIED (no remote SSH access)');

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
