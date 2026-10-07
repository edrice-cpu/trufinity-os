import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { CallAnalysisCanonicalService } from '../../src/modules/lace/canonical/call-analysis.canonical.service';

describe('CallAnalysisCanonicalService', () => {
  beforeEach(async () => {
    await db('canonical_lace_calls').delete();
    await db('raw_lace_call_analysis').delete();
  });

  afterAll(async () => {
    await db('canonical_lace_calls').delete();
    await db('raw_lace_call_analysis').delete();
    await db.destroy();
  });

  it('maps only is_latest raw rows into typed canonical columns', async () => {
    await db('raw_lace_call_analysis').insert([
      {
        source_id: 'call-1',
        is_latest: true,
        payload: {
          CRM: 'SERVICE_TITAN',
          CSR: 'Dana Whitfield',
          Booked: 'Booked',
          Qualified: 'Qualified',
          'Call link': 'https://www.lace.ai/app/call-center-all-calls/call-1',
          'Duration (sec)': '210',
          'Playbook score': '75%',
          Objections: 'Value Concerns, Other',
          'Date received (UTC)': '2026-08-24',
          'Time received (UTC)': '12:00:00',
        },
      },
      {
        source_id: 'call-2-stale',
        is_latest: false,
        payload: { 'Call link': 'https://www.lace.ai/app/call-center-all-calls/call-2-stale', Booked: 'Unbooked' },
      },
    ]);

    const result = await new CallAnalysisCanonicalService().sync();

    expect(result.rowsUpserted).toBe(1);
    const rows = await db('canonical_lace_calls');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lace_call_id: 'call-1',
      csr: 'Dana Whitfield',
      booked: true,
      qualified: true,
      duration_sec: 210,
      playbook_score: 75,
      objections: ['Value Concerns', 'Other'],
    });
    expect(new Date(rows[0].received_at as Date).toISOString()).toBe('2026-08-24T12:00:00.000Z');
  });

  it('upserts on lace_call_id instead of duplicating when re-run after a corrected re-export', async () => {
    await db('raw_lace_call_analysis').insert({
      source_id: 'call-1',
      is_latest: true,
      payload: { Booked: 'Unbooked', 'Call link': 'https://www.lace.ai/app/call-center-all-calls/call-1' },
    });
    await new CallAnalysisCanonicalService().sync();

    await db('raw_lace_call_analysis').where({ source_id: 'call-1' }).update({
      payload: { Booked: 'Booked', 'Call link': 'https://www.lace.ai/app/call-center-all-calls/call-1' },
    });
    await new CallAnalysisCanonicalService().sync();

    const rows = await db('canonical_lace_calls');
    expect(rows).toHaveLength(1);
    expect(rows[0].booked).toBe(true);
  });
});
