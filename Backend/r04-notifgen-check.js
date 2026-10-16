const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });
async function run() {
  // Check column default for notification_generation
  const colDef = await db.raw(`
    SELECT column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'google_after_hours_backlog_alerts' AND column_name = 'notification_generation'
  `);
  console.log('=== notification_generation COLUMN DEFAULT ===');
  colDef.rows.forEach(r => console.log('  column_default: ' + r.column_default + ' | nullable: ' + r.is_nullable));

  // Check the migration that defines this column
  const migCheck = await db.raw(`
    SELECT migration_name FROM knex_migrations WHERE migration_name ILIKE '%after_hours%' ORDER BY migration_name
  `);
  console.log('\n=== MIGRATIONS (after_hours) ===');
  if (migCheck.rows.length === 0) console.log('  (none found in knex_migrations)');
  else migCheck.rows.forEach(r => console.log('  ' + r.migration_name));

  // Is the insert path in openAlert() providing notification_generation explicitly?
  // The code does NOT include notification_generation in the INSERT fields,
  // so it relies on the column default. If default=1 then all first inserts get gen=1.
  // Verify: are there any rows with gen=0?
  const genZero = await db('google_after_hours_backlog_alerts').where({ notification_generation: 0 }).count({ c: '*' }).first();
  const genOne  = await db('google_after_hours_backlog_alerts').where({ notification_generation: 1 }).count({ c: '*' }).first();
  console.log('\n=== GENERATION COUNTS ===');
  console.log('  gen=0: ' + genZero.c);
  console.log('  gen=1: ' + genOne.c);

  await db.destroy();
}
run().catch(e => { console.error('DB_ERROR: ' + e.message); process.exit(1); });
