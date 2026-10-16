const knex = require('knex');
require('dotenv').config();
const db = knex({ client: 'pg', connection: { host: '127.0.0.1', port: parseInt(process.env.DB_PORT||'5433'), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME } });
async function run() {
  const id = await db.raw("SELECT current_database() AS d, inet_server_port() AS p");
  console.log('db=' + id.rows[0].d + ' server_port=' + id.rows[0].p);
  const lk = await db.raw("SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS a");
  const a = lk.rows[0].a;
  console.log('lock_acquirable=' + a + (a ? ' PASS' : ' BLOCKED'));
  if (a) {
    await db.raw("SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))");
    console.log('lock_released=true');
  }
  await db.destroy();
}
run().catch(e => { console.error('ERR: ' + e.message); process.exit(1); });
