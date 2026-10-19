import { afterAll, describe, expect, it } from '@jest/globals';
import type { Knex } from 'knex';
import { db } from '../../src/database';
import { getLaceFreshness } from '../../src/modules/lace/lace-freshness';

// Each case runs in a rolled-back transaction so its sync_runs / file rows
// never reach other test files. Fixtures sit in 2082 - later than any real or
// other-test row - so they are always "the latest" from the check's view.
async function inRollback(run: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const trx = await db.transaction();
  try {
    await run(trx);
  } finally {
    await trx.rollback();
  }
}

const NOW = new Date('2082-06-15T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function run(trx: Knex.Transaction, entityType: string, status: string, startedHoursAgo: number) {
  await trx('sync_runs').insert({
    source_system: 'LaceAI', entity_type: entityType, status,
    started_at: hoursAgo(startedHoursAgo), completed_at: hoursAgo(startedHoursAgo - 0.1), records_processed: 10,
  });
}

async function file(trx: Knex.Transaction, exportType: string, ingestedHoursAgo: number) {
  await trx('lace_ingested_files').insert({
    export_type: exportType, s3_key: `freshness-test/${exportType}/${ingestedHoursAgo}.csv`, s3_etag: 'e', row_count: 1, ingested_at: hoursAgo(ingestedHoursAgo),
  });
}

const callAnalysis = async (trx: Knex.Transaction) => (await getLaceFreshness(trx, NOW)).find((f) => f.exportType === 'call_analysis')!;

afterAll(async () => {
  await db.destroy();
});

describe('getLaceFreshness', () => {
  it('is OK when the last run succeeded and a file arrived within the window', async () => {
    await inRollback(async (trx) => {
      await run(trx, 'call_analysis', 'COMPLETED', 2);
      await file(trx, 'call_analysis', 2);
      await trx('canonical_lace_calls').insert({ lace_call_id: 'freshness-test-call', call_link: 'x', received_at: hoursAgo(10) });
      await trx('canonical_lace_calls').insert({ lace_call_id: 'freshness-test-future', call_link: 'y', received_at: new Date('2099-01-01T00:00:00Z') });

      const f = await callAnalysis(trx);
      expect(f).toMatchObject({ status: 'OK', consecutiveFailures: 0, lastRunStatus: 'COMPLETED', maxFileAgeHours: 36 });
      // A future-dated call (bad data / fixtures) never counts as the newest data.
      expect(f.latestDataAt).toBe(hoursAgo(10).toISOString());
    });
  });

  it('is FAILING when the latest runs failed after the last success', async () => {
    await inRollback(async (trx) => {
      await run(trx, 'call_analysis', 'COMPLETED', 30);
      await file(trx, 'call_analysis', 30);
      await run(trx, 'call_analysis', 'FAILED', 5);
      await run(trx, 'call_analysis', 'FAILED', 2);

      expect(await callAnalysis(trx)).toMatchObject({ status: 'FAILING', consecutiveFailures: 2, lastRunStatus: 'FAILED' });
    });
  });

  it('is STALE when runs succeed but no new file has arrived within the window', async () => {
    await inRollback(async (trx) => {
      await file(trx, 'call_analysis', 50);
      await run(trx, 'call_analysis', 'COMPLETED', 1);

      expect(await callAnalysis(trx)).toMatchObject({ status: 'STALE', consecutiveFailures: 0 });
    });
  });

  it('uses a monthly window for agent performance and reads its latest report period', async () => {
    await inRollback(async (trx) => {
      await run(trx, 'agent_performance', 'COMPLETED', 24 * 20);
      await file(trx, 'agent_performance', 24 * 20);
      await trx('raw_lace_agent_performance').insert({
        source_id: 'freshness-test__2082-05-01 04:00:00__2082-05-31 21:00:00', is_latest: true,
        payload: { CSR: 'X', 'Period Start': '2082-05-01 04:00:00', 'Period End': '2082-05-31 21:00:00' },
      });

      const f = (await getLaceFreshness(trx, NOW)).find((x) => x.exportType === 'agent_performance')!;
      expect(f).toMatchObject({ status: 'OK', maxFileAgeHours: 45 * 24 });
      expect(f.latestDataAt).toBe('2082-05-31T21:00:00.000Z');
    });
  });
});
