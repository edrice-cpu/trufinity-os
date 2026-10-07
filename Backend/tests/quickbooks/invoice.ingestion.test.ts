import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { QboInvoiceIngestionService } from '../../src/modules/quickbooks/ingestion/invoice.ingestion';

describe('QBO Invoice raw ingestion', () => {
  beforeEach(async () => { await db('raw_qbo_invoices').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Invoices' }).delete(); });
  afterAll(async () => { await db('raw_qbo_invoices').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Invoices' }).delete(); await db.destroy(); });
  it('loads paginated invoices and preserves payloads', async () => {
    const api = { getInvoicesPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { Invoice: [{ Id: '1', TotalAmt: 10 }], totalCount: 2, maxResults: 1 }, time: 't' })
      .mockResolvedValueOnce({ QueryResponse: { Invoice: [{ Id: '2', TotalAmt: 20 }], totalCount: 2, maxResults: 1 }, time: 't' }) };
    const result = await new QboInvoiceIngestionService(api).run();
    expect(result.recordsProcessed).toBe(2); expect(api.getInvoicesPage).toHaveBeenNthCalledWith(1, 1, 1000); expect(api.getInvoicesPage).toHaveBeenNthCalledWith(2, 2, 1000);
    const rows = await db('raw_qbo_invoices').orderBy('source_id'); expect(rows).toHaveLength(2); expect(rows[0].payload.Id).toBe(rows[0].source_id);
    const run = await db('sync_runs').where({ id: result.syncRunId }).first(); expect(run.status).toBe('COMPLETED');
  });

  it('continues after full pages even when totalCount equals page size', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) }));
    const next = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1001) }));
    const api = { getInvoicesPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValueOnce({ QueryResponse: { Invoice: full, totalCount: 1000, maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: { Invoice: next, totalCount: 1000, maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: { Invoice: [{ Id: '2001' }], maxResults: 1000 } }).mockResolvedValueOnce({ QueryResponse: { startPosition: 2002, maxResults: 1000, totalCount: 2001 } }) };
    const result = await new QboInvoiceIngestionService(api).run();
    expect(api.getInvoicesPage).toHaveBeenNthCalledWith(1, 1, 1000);
    expect(api.getInvoicesPage).toHaveBeenNthCalledWith(2, 1001, 1000);
    expect(result.recordsProcessed).toBe(2001);
  });

  it('accepts an omitted Invoice property as a valid terminal page and rejects malformed shapes', async () => {
    const terminalApi = { getInvoicesPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue({ QueryResponse: {} }) };
    await expect(new QboInvoiceIngestionService(terminalApi).run()).resolves.toMatchObject({ recordsProcessed: 0 });
    for (const response of [{}, { QueryResponse: { Invoice: {} } }]) {
      const api = { getInvoicesPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue(response) };
      await expect(new QboInvoiceIngestionService(api).run()).rejects.toThrow('QuickBooks Invoices ingestion failed.');
    }
  });
});
