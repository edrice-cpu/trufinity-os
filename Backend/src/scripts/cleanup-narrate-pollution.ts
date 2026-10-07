// One-off cleanup for a real incident: a test run (invoked in a way that
// never set NODE_ENV=test - see the hardened guard in src/config/env.ts and
// tests/db-isolation.guard.test.ts) connected to the live production
// database and:
//   (a) wrote the jest mock's placeholder narrative text onto real,
//       already-detected D-06 alerts (narrateService.run() has no
//       row-scoping, so it narrated every row with narrative IS NULL -
//       see the `ids` option added to NarrateService.run() to prevent this
//       going forward), and
//   (b) left behind test-fixture detected_alerts rows (sentinel
//       period_start years far in the future, used by tests/deliver and
//       tests/detect to avoid colliding with real data).
//
// Safe by default: prints exactly what would change and makes no writes
// unless run with --confirm. Both operations run inside a single
// transaction with --confirm, so this never leaves the table half-fixed.
// Idempotent: re-running after --confirm finds 0 rows for both operations,
// since the UPDATE's WHERE no longer matches already-cleared rows and the
// DELETE's WHERE no longer matches already-deleted rows.
//
//   npx ts-node -T src/scripts/cleanup-narrate-pollution.ts            (dry run)
//   npx ts-node -T src/scripts/cleanup-narrate-pollution.ts --confirm  (writes)
//
// or: npm run cleanup:narrate-pollution [-- --confirm]
import { db } from '../database';

const POLLUTED_NARRATIVE = 'should not be called for this row';
// No real rule's trailing-week window ever lands this far in the future
// (current real data is dated 2026) - this is the same sentinel-year
// convention tests/* already use (see src/scripts/cleanup-test-fixture-rows.ts).
const FIXTURE_PERIOD_START_FLOOR = '2090-01-01';

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');

  const pollutedNarratives = await db('detected_alerts')
    .where('narrative', POLLUTED_NARRATIVE)
    .select('id', 'rule_code', 'dimension', 'period_start', 'narrated_at');
  console.log(`\ndetected_alerts - narrative = '${POLLUTED_NARRATIVE}' (test-mock text written onto real rows)`);
  console.log(`  ${pollutedNarratives.length} row(s) found${pollutedNarratives.length > 0 ? ':' : ''}`);
  for (const row of pollutedNarratives) {
    console.log(`    ${row.id}  rule=${row.rule_code}  dimension=${row.dimension}  period_start=${new Date(row.period_start).toISOString()}  narrated_at=${new Date(row.narrated_at).toISOString()}`);
  }

  const fixtureRows = await db('detected_alerts')
    .where('period_start', '>=', FIXTURE_PERIOD_START_FLOOR)
    .select('id', 'rule_code', 'dimension', 'period_start');
  console.log(`\ndetected_alerts - period_start >= ${FIXTURE_PERIOD_START_FLOOR} (test fixtures)`);
  console.log(`  ${fixtureRows.length} row(s) found${fixtureRows.length > 0 ? ':' : ''}`);
  for (const row of fixtureRows) {
    console.log(`    ${row.id}  rule=${row.rule_code}  dimension=${row.dimension}  period_start=${new Date(row.period_start).toISOString()}`);
  }

  if (!confirm) {
    console.log(`\n${pollutedNarratives.length} row(s) would be reset (narrative/narrated_at -> NULL).`);
    console.log(`${fixtureRows.length} row(s) would be deleted.`);
    console.log(`\nRe-run with --confirm to apply these changes.`);
    await db.destroy();
    return;
  }

  await db.transaction(async (trx) => {
    const resetCount = await trx('detected_alerts')
      .where('narrative', POLLUTED_NARRATIVE)
      .update({ narrative: null, narrated_at: null });
    console.log(`\nReset ${resetCount} row(s)' narrative/narrated_at to NULL.`);

    const deletedCount = await trx('detected_alerts')
      .where('period_start', '>=', FIXTURE_PERIOD_START_FLOOR)
      .delete();
    console.log(`Deleted ${deletedCount} test-fixture row(s).`);
  });

  console.log(`\nDone. The 5 reset D-06 alerts will be picked up and re-narrated on the next narrateService.run() (NarrateService.run() processes every row with narrative IS NULL).`);
  await db.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
