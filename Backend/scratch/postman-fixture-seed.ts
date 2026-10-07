/**
 * POSTMAN TEST FIXTURE — SEED SCRIPT
 *
 * Inserts one synthetic REVIEW_REQUIRED work item for manual Postman testing of:
 *   POST /api/google/work-items/:id/acknowledge
 *   POST /api/google/work-items/:id/resolve
 *
 * SAFETY GUARDS:
 *   - Will NOT modify or touch bad81844-b7e0-4760-b87c-a02f9e2f25e1
 *   - All synthetic records use provider_message_id prefix MANUAL_POSTMAN_TEST_
 *   - Idempotency: aborts if a record with the same idempotency_key already exists
 *   - Does not trigger any worker, scheduler, Gmail API call, Anthropic call, or SMTP
 *   - raw_gmail_messages is NOT inserted (LEFT JOIN in API, senderFrom will be null)
 *
 * Run: npx ts-node scratch/postman-fixture-seed.ts
 */

// Reuses the same Knex instance the backend and migrations use.
// Connection is configured via DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
// and NODE_ENV in .env — see src/database/index.ts and src/database/knexfile.ts.
import { db } from '../src/database';

const IDEMPOTENCY_KEY = 'MANUAL_POSTMAN_TEST_fixture_v1_20261006';
const PROVIDER_MESSAGE_ID = 'MANUAL_POSTMAN_TEST_0000000000000001';

async function seed(): Promise<void> {
  // Idempotency check — abort if already exists
  const existing = await db('email_classification_results')
    .where('idempotency_key', IDEMPOTENCY_KEY)
    .first();

  if (existing) {
    console.log('⚠️  Fixture already exists — aborting to avoid duplicate.');
    console.log(`   classification_result id : ${existing.id}`);
    const wi = await db('email_escalation_work_items')
      .where('classification_result_id', existing.id)
      .first();
    console.log(`   work_item id             : ${wi?.id ?? '(not found)'}`);
    await db.destroy();
    return;
  }

  await db.transaction(async (trx) => {
    // 1. Insert classification result
    const [classificationResult] = await trx('email_classification_results')
      .insert({
        mailbox_address: 'postman-test@example.invalid',
        provider_message_id: PROVIDER_MESSAGE_ID,
        classification_label: 'escalation_request',
        confidence: 0.72,
        // reason: ≤280 chars, no newlines, not blank
        reason: 'Temporary Postman test fixture inserted by scratch/postman-fixture-seed.ts — safe to delete via scratch/postman-fixture-cleanup.ts',
        decision_status: 'REVIEW_REQUIRED',
        model_provider: 'anthropic',
        model_name: 'claude-haiku-4-5-20251001',
        prompt_version: 'v0-postman-test',
        classified_at: new Date(),
        idempotency_key: IDEMPOTENCY_KEY,
        // mailbox_id intentionally null — no real mailbox row required
      })
      .returning('*');

    console.log('✅ Inserted classification result:');
    console.log(`   id               : ${classificationResult.id}`);
    console.log(`   decision_status  : ${classificationResult.decision_status}`);
    console.log(`   idempotency_key  : ${classificationResult.idempotency_key}`);

    // 2. Insert work item
    const [workItem] = await trx('email_escalation_work_items')
      .insert({
        classification_result_id: classificationResult.id,
        provider_message_id: PROVIDER_MESSAGE_ID,
        work_type: 'REVIEW_REQUIRED',
        workflow_status: 'OPEN',
        sla_state: 'ON_TRACK',
        // Future deadline so it is not effectively BREACHED
        resolution_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // +7 days
        // mailbox_id nullable — leave null
      })
      .returning('*');

    console.log('\n✅ Inserted work item:');
    console.log(`   id                   : ${workItem.id}`);
    console.log(`   workflow_status      : ${workItem.workflow_status}`);
    console.log(`   sla_state            : ${workItem.sla_state}`);
    console.log(`   resolution_deadline  : ${workItem.resolution_deadline}`);

    console.log('\n─────────────────────────────────────────────────────────');
    console.log('POSTMAN — copy these IDs:');
    console.log(`  classification_result_id : ${classificationResult.id}`);
    console.log(`  work_item_id             : ${workItem.id}`);
    console.log('\nEndpoints to test:');
    console.log(`  POST /api/google/work-items/${workItem.id}/acknowledge`);
    console.log(`  POST /api/google/work-items/${workItem.id}/resolve`);
    console.log('    Body (JSON): { "resolution_note": "Resolved during Postman test." }');
    console.log('─────────────────────────────────────────────────────────');
    console.log('\nWhen done testing, run the cleanup script:');
    console.log('  npx ts-node scratch/postman-fixture-cleanup.ts');
  });

  await db.destroy();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
