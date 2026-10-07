import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { QboPaymentIngestionService } from '../../src/modules/quickbooks/ingestion/payment.ingestion';

describe('QBO Payment raw ingestion', () => {
  beforeEach(async () => { await db('raw_qbo_payments').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Payments' }).delete(); });
  // Matches what beforeEach already deletes, so the last test's rows don't
  // linger, then closes the connection pool so Jest can exit cleanly.
  afterAll(async () => { await db('raw_qbo_payments').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Payments' }).delete(); await db.destroy(); });
  it('loads paginated payments and preserves payloads', async () => {
    const api = { getPaymentsPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { Payment: [{ Id: '1', TotalAmt: 10 }], totalCount: 2, maxResults: 1 }, time: 't' })
      .mockResolvedValueOnce({ QueryResponse: { Payment: [{ Id: '2', TotalAmt: 20 }], totalCount: 2, maxResults: 1 }, time: 't' }) };
    const result = await new QboPaymentIngestionService(api).run();
    expect(result.recordsProcessed).toBe(2); expect(api.getPaymentsPage).toHaveBeenNthCalledWith(1, 1, 1000); expect(api.getPaymentsPage).toHaveBeenNthCalledWith(2, 2, 1000);
    const rows = await db('raw_qbo_payments').orderBy('source_id'); expect(rows).toHaveLength(2); expect(rows[0].payload.Id).toBe(rows[0].source_id);
    const run = await db('sync_runs').where({ id: result.syncRunId }).first(); expect(run.status).toBe('COMPLETED');
  });

  it('continues across full pages regardless of totalCount', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) }));
    const second = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1001) }));
    const api = { getPaymentsPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValueOnce({ QueryResponse: { Payment: first, totalCount: 1000, maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: { Payment: second, totalCount: 1000, maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: { Payment: [{ Id: '2001' }], maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: {} }) };
    const result = await new QboPaymentIngestionService(api).run();
    expect(api.getPaymentsPage).toHaveBeenNthCalledWith(1, 1, 1000);
    expect(api.getPaymentsPage).toHaveBeenNthCalledWith(2, 1001, 1000);
    expect(result.recordsProcessed).toBe(2001);
  });

  it('accepts an omitted Payment property at the terminal page and rejects malformed responses', async () => {
    const terminalApi = { getPaymentsPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue({ QueryResponse: {} }) };
    await expect(new QboPaymentIngestionService(terminalApi).run()).resolves.toMatchObject({ recordsProcessed: 0 });
    for (const response of [{}, { QueryResponse: { Payment: {} } }]) {
      const api = { getPaymentsPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue(response) };
      await expect(new QboPaymentIngestionService(api).run()).rejects.toThrow('QuickBooks Payments ingestion failed.');
    }
  });
});
