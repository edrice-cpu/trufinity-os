import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { QboAccountIngestionService } from '../../src/modules/quickbooks/ingestion/account.ingestion';

describe('QBO Account raw ingestion', () => {
  beforeEach(async () => { await db('raw_qbo_accounts').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Accounts' }).delete(); });
  afterAll(async () => { await db('raw_qbo_accounts').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Accounts' }).delete(); await db.destroy(); });
  it('loads paginated accounts and persists source IDs', async () => {
    const api = { getAccountsPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { Account: [{ Id: '1', Name: 'Cash' }], totalCount: 2, maxResults: 1 }, time: 't' })
      .mockResolvedValueOnce({ QueryResponse: { Account: [{ Id: '2', Name: 'Sales' }], totalCount: 2, maxResults: 1 }, time: 't' }) };
    const result = await new QboAccountIngestionService(api).run();
    expect(result.recordsProcessed).toBe(2); expect(api.getAccountsPage).toHaveBeenNthCalledWith(1, 1, 1000); expect(api.getAccountsPage).toHaveBeenNthCalledWith(2, 2, 1000);
    const rows = await db('raw_qbo_accounts').orderBy('source_id'); expect(rows).toHaveLength(2); expect(rows[0].payload.Id).toBe(rows[0].source_id);
    const run = await db('sync_runs').where({ id: result.syncRunId }).first(); expect(run.status).toBe('COMPLETED');
  });

  it('accepts an omitted Account property as the valid empty final page', async () => {
    await db('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Accounts', continuation_token: '325' });
    const api = { getAccountsPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue({ QueryResponse: { startPosition: 325, maxResults: 1000, totalCount: 324 }, time: 't' }) };
    const result = await new QboAccountIngestionService(api).run();
    expect(api.getAccountsPage).toHaveBeenCalledWith(325, 1000);
    expect(result.recordsProcessed).toBe(0);
    const metadata = await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Accounts' }).first();
    expect(metadata.continuation_token).toBeNull();
  });

  it('rejects missing QueryResponse and non-array Account values', async () => {
    for (const response of [{}, { QueryResponse: { Account: {} } }]) {
      const api = { getAccountsPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue(response) };
      await expect(new QboAccountIngestionService(api).run()).rejects.toThrow('QuickBooks Accounts ingestion failed.');
    }
  });
});
