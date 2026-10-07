// One-off cleanup for test-fixture rows that leaked into a real database
// before test isolation existed (see tests/jest.setup-env.js). Identifies
// rows by the same far-future "sentinel year" marker dates the test files
// themselves use to scope their own cleanup - see each query's comment for
// which test file established that marker.
//
// Safe by default: prints what it would delete and makes no changes unless
// run with --confirm.
//
//   npx ts-node -T src/scripts/cleanup-test-fixture-rows.ts            (dry run)
//   npx ts-node -T src/scripts/cleanup-test-fixture-rows.ts --confirm  (deletes)
//
// or: npm run cleanup:test-fixtures [-- --confirm]
import { db } from '../database';

interface MarkerQuery {
  table: string;
  description: string;
  // Returns the matching rows' primary keys for the dry-run report, and is
  // also what gets deleted (by id) when --confirm is passed.
  find: () => Promise<{ id: string }[]>;
}

const QUERIES: MarkerQuery[] = [
  {
    table: 'detected_alerts',
    description: "period_start >= 2094-01-01 (sentinel years 2094-2099 used across tests/deliver, tests/detect, tests/narrate)",
    find: () => db('detected_alerts').where('period_start', '>=', '2094-01-01').select('id'),
  },
  {
    table: 'canonical_lace_calls',
    description: "received_at >= 2097-01-01 (sentinel years 2097-2099 used across tests/detect)",
    find: () => db('canonical_lace_calls').where('received_at', '>=', '2097-01-01').select('id'),
  },
  {
    table: 'lace_ingested_files',
    description: "s3_key LIKE 'idempotency-test/%' (tests/lace/lace-raw.ingestion.idempotency.test.ts)",
    find: () => db('lace_ingested_files').where('export_type', 'call_analysis').andWhere('s3_key', 'like', 'idempotency-test/%').select('id'),
  },
  {
    table: 'raw_lace_call_analysis',
    description: "source_id LIKE 'idem-%' (tests/lace/lace-raw.ingestion.idempotency.test.ts)",
    find: () => db('raw_lace_call_analysis').where('source_id', 'like', 'idem-%').select('id'),
  },
];

// Tables some test files write to with NO fixture marker at all (a plain
// `.delete()` of the whole table in beforeEach - see tests/quickbooks/*.ingestion.test.ts
// and tests/lace/call-analysis.canonical.service.test.ts). There is no way
// to tell a leftover test row apart from a real one after the fact, so this
// script deliberately does not touch them. Test isolation (tests/jest.setup-env.js)
// prevents any *new* leakage into these tables; cleaning up past leakage, if
// any, would need manual inspection.
const UNSAFE_TO_AUTO_CLEAN = [
  'raw_qbo_customers', 'raw_qbo_invoices', 'raw_qbo_payments', 'raw_qbo_accounts', 'raw_qbo_companyinfo', 'raw_qbo_creditmemos',
  'raw_sync_metadata', 'raw_lace_call_analysis (canonical-service-test\'s blanket delete)', 'sync_runs',
];

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');

  let totalFound = 0;
  for (const query of QUERIES) {
    const rows = await query.find();
    totalFound += rows.length;
    console.log(`\n${query.table} - ${query.description}`);
    console.log(`  ${rows.length} row(s) found${rows.length > 0 ? ':' : ''}`);
    for (const row of rows) console.log(`    ${row.id}`);

    if (confirm && rows.length > 0) {
      const deleted = await db(query.table).whereIn('id', rows.map((r) => r.id)).delete();
      console.log(`  Deleted ${deleted} row(s).`);
    }
  }

  console.log(`\nTables this script cannot safely check (no fixture marker - see comment above UNSAFE_TO_AUTO_CLEAN in this file):`);
  for (const table of UNSAFE_TO_AUTO_CLEAN) console.log(`  - ${table}`);

  if (!confirm) {
    console.log(`\n${totalFound} row(s) would be deleted. Re-run with --confirm to actually delete them.`);
  } else {
    console.log(`\nDone.`);
  }

  await db.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
