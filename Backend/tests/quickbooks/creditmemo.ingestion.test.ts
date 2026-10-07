import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { QboCreditMemoIngestionService } from '../../src/modules/quickbooks/ingestion/creditmemo.ingestion';

describe('QBO CreditMemo raw ingestion', () => {
  // The default 5s timeout is occasionally too tight for this DB connection's
  // round-trip latency (advisory lock + several sequential queries per
  // page) - bump it rather than let the suite flake on infra timing.
  jest.setTimeout(30000);

  beforeEach(async () => { await db('raw_qbo_creditmemos').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CreditMemos' }).delete(); });
  afterAll(async () => { await db('raw_qbo_creditmemos').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CreditMemos' }).delete(); await db.destroy(); });

  it('loads paginated credit memos and preserves payloads', async () => {
    const api = { getCreditMemosPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: [{ Id: '1', TotalAmt: 50, RemainingCredit: 50 }], totalCount: 2, maxResults: 1 }, time: 't' })
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: [{ Id: '2', TotalAmt: 75, RemainingCredit: 0 }], totalCount: 2, maxResults: 1 }, time: 't' }) };
    const result = await new QboCreditMemoIngestionService(api).run();
    expect(result.recordsProcessed).toBe(2); expect(api.getCreditMemosPage).toHaveBeenNthCalledWith(1, 1, 1000); expect(api.getCreditMemosPage).toHaveBeenNthCalledWith(2, 2, 1000);
    const rows = await db('raw_qbo_creditmemos').orderBy('source_id'); expect(rows).toHaveLength(2); expect(rows[0].payload.Id).toBe(rows[0].source_id);
    const run = await db('sync_runs').where({ id: result.syncRunId }).first(); expect(run.status).toBe('COMPLETED');
  });

  it('continues after full pages even when totalCount equals page size', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) }));
    const next = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1001) }));
    const api = { getCreditMemosPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: full, totalCount: 1000, maxResults: 1000 } })
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: next, totalCount: 1000, maxResults: 1000 } })
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: [{ Id: '2001' }], maxResults: 1000 } })
      .mockResolvedValueOnce({ QueryResponse: { startPosition: 2002, maxResults: 1000, totalCount: 2001 } }) };
    const result = await new QboCreditMemoIngestionService(api).run();
    expect(api.getCreditMemosPage).toHaveBeenNthCalledWith(1, 1, 1000);
    expect(api.getCreditMemosPage).toHaveBeenNthCalledWith(2, 1001, 1000);
    expect(result.recordsProcessed).toBe(2001);
  });

  it('accepts an omitted CreditMemo property as a valid terminal page and rejects malformed shapes', async () => {
    const terminalApi = { getCreditMemosPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue({ QueryResponse: {} }) };
    await expect(new QboCreditMemoIngestionService(terminalApi).run()).resolves.toMatchObject({ recordsProcessed: 0 });
    for (const response of [{}, { QueryResponse: { CreditMemo: {} } }]) {
      const api = { getCreditMemosPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue(response) };
      await expect(new QboCreditMemoIngestionService(api).run()).rejects.toThrow('QuickBooks CreditMemos ingestion failed.');
    }
  });

  it('records a malformed record (missing Id) in sync_errors without failing the whole batch', async () => {
    const api = { getCreditMemosPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { CreditMemo: [{ Id: '1', TotalAmt: 10 }, { TotalAmt: 5 }], totalCount: 2, maxResults: 2 } }) };
    const result = await new QboCreditMemoIngestionService(api).run();
    expect(result.recordsProcessed).toBe(1);
    const errors = await db('sync_errors').where({ sync_run_id: result.syncRunId });
    expect(errors).toHaveLength(1);
    expect(errors[0].error_message).toContain('missing a valid Id');
  });
});
