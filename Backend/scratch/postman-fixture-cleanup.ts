/**
 * POSTMAN TEST FIXTURE — CLEANUP SCRIPT
 *
 * Deletes ONLY the synthetic records inserted by postman-fixture-seed.ts.
 * Deletion order respects FK constraints:
 *   1. email_escalation_work_items  (references email_classification_results)
 *   2. email_classification_results
 *
 * SAFETY GUARDS:
 *   - Explicitly refuses to delete bad81844-b7e0-4760-b87c-a02f9e2f25e1
 *   - Targets records only via provider_message_id prefix MANUAL_POSTMAN_TEST_
 *     AND idempotency_key exact match — both conditions must hold
 *   - Prints a dry-run summary before deleting; aborts if nothing found
 *   - Does not touch any other row in any table
 *
 * Run: npx ts-node scratch/postman-fixture-cleanup.ts
 */

// Reuses the same Knex instance the backend and migrations use.
// Connection is configured via DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
// and NODE_ENV in .env — see src/database/index.ts and src/database/knexfile.ts.
import { db } from '../src/database';

const IDEMPOTENCY_KEY = 'MANUAL_POSTMAN_TEST_fixture_v1_20261006';
const PROVIDER_MESSAGE_ID_PREFIX = 'MANUAL_POSTMAN_TEST_';

// Hard guard: this real work item must NEVER be deleted by this script.
const PROTECTED_WORK_ITEM_ID = 'bad81844-b7e0-4760-b87c-a02f9e2f25e1';

async function cleanup(): Promise<void> {
  // Locate the classification result by idempotency key + provider_message_id prefix
  const classificationResult = await db('email_classification_results')
    .where('idempotency_key', IDEMPOTENCY_KEY)
    .whereLike('provider_message_id', `${PROVIDER_MESSAGE_ID_PREFIX}%`)
    .first();

  if (!classificationResult) {
    console.log('ℹ️  No fixture records found — nothing to clean up.');
    await db.destroy();
    return;
  }

  // Locate the associated work item
  const workItem = await db('email_escalation_work_items')
    .where('classification_result_id', classificationResult.id)
    .first();

  // Hard guard — should never trigger, but belt-and-suspenders
  if (workItem && workItem.id === PROTECTED_WORK_ITEM_ID) {
    console.error('🛑 ABORT: cleanup would have touched the protected work item.');
    console.error(`   Protected ID: ${PROTECTED_WORK_ITEM_ID}`);
    process.exit(1);
  }

  // Dry-run summary
  console.log('Records to delete:');
  console.log(`  email_escalation_work_items      id: ${workItem?.id ?? '(none found)'}`);
  console.log(`  email_classification_results     id: ${classificationResult.id}`);
  console.log(`  provider_message_id              : ${classificationResult.provider_message_id}`);
  console.log(`  idempotency_key                  : ${classificationResult.idempotency_key}`);
  console.log('');

  await db.transaction(async (trx) => {
    // 1. Delete work item first (FK child)
    if (workItem) {
      const wiDeleted = await trx('email_escalation_work_items')
        .where('id', workItem.id)
        .where('classification_result_id', classificationResult.id) // extra guard
        .whereNot('id', PROTECTED_WORK_ITEM_ID)                      // hard guard
        .delete();
      console.log(`✅ Deleted ${wiDeleted} row(s) from email_escalation_work_items`);
    } else {
      console.log('ℹ️  No work item row found (already deleted or never created).');
    }

    // 2. Delete classification result (FK parent)
    const crDeleted = await trx('email_classification_results')
      .where('id', classificationResult.id)
      .where('idempotency_key', IDEMPOTENCY_KEY)
      .delete();
    console.log(`✅ Deleted ${crDeleted} row(s) from email_classification_results`);
  });

  console.log('\nCleanup complete. Fixture records removed.');
  await db.destroy();
}

cleanup().catch((err) => {
  console.error('❌ Cleanup failed:', err.message);
  process.exit(1);
});
