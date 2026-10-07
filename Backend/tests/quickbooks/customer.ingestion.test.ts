import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { logger } from '../../src/utils/logger';
import { QboCustomerIngestionService } from '../../src/modules/quickbooks/ingestion/customer.ingestion';

describe('QBO Customer raw ingestion', () => {
  beforeEach(async () => { await db('raw_qbo_customers').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Customers' }).delete(); });
  afterAll(async () => { await db('raw_qbo_customers').delete(); await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Customers' }).delete(); await db.destroy(); });
  it('loads all pages and preserves payloads/versioning', async () => {
    const api = { getCustomersPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValueOnce({ QueryResponse: { Customer: [{ Id: '1', DisplayName: 'A' }], totalCount: 2, maxResults: 1 }, time: 't' })
      .mockResolvedValueOnce({ QueryResponse: { Customer: [{ Id: '2', DisplayName: 'B' }], totalCount: 2, maxResults: 1 }, time: 't' }) };
    const result = await new QboCustomerIngestionService(api).run();
    expect(result.recordsProcessed).toBe(2); expect(api.getCustomersPage).toHaveBeenCalledTimes(2); expect(api.getCustomersPage).toHaveBeenNthCalledWith(1, 1, 1000); expect(api.getCustomersPage).toHaveBeenNthCalledWith(2, 2, 1000);
    const rows = await db('raw_qbo_customers').orderBy('source_id'); expect(rows).toHaveLength(2); expect(rows[0].payload.Id).toBe(rows[0].source_id);
    const run = await db('sync_runs').where({ id: result.syncRunId }).first(); expect(run.status).toBe('COMPLETED');
  });

  it('logs safe database diagnostics and preserves the original failure cause', async () => {
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const api = { getCustomersPage: jest.fn<(position: number, size: number) => Promise<any>>()
      .mockResolvedValue({ QueryResponse: { Customer: [{ Id: 'duplicate-id' }, { Id: 'duplicate-id' }], totalCount: 2, maxResults: 2 } }) };

    let thrown: unknown;
    try { await new QboCustomerIngestionService(api).run(); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBeDefined();
    const failedRun = await db('sync_runs').where({ source_system: 'QuickBooks', entity_type: 'Customers', status: 'FAILED' }).orderBy('started_at', 'desc').first();
    expect(failedRun.error_message).toContain('persist_page_transaction');
    expect(failedRun.error_message).toContain('23505');
    expect(failedRun.records_processed).toBe(0);
    const loggedDiagnostic = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(loggedDiagnostic).toContain('persist_page_transaction');
    expect(loggedDiagnostic).toContain('23505');
    expect(loggedDiagnostic).toContain('raw_qbo_customers_source_id_ingested_at_unique');
    expect(loggedDiagnostic).not.toContain('accessToken');
    expect(loggedDiagnostic).not.toContain('refreshToken');
    logSpy.mockRestore();
  });
  it('treats an omitted Customer property in a valid QueryResponse as the empty final page', async () => {
    await db('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Customers', continuation_token: '7729' });
    const api = { getCustomersPage: jest.fn<(position: number, size: number) => Promise<any>>() .mockResolvedValue({ QueryResponse: { startPosition: 7729, maxResults: 1000, totalCount: 7728 }, time: 't' }) };
    const result = await new QboCustomerIngestionService(api).run();
    expect(api.getCustomersPage).toHaveBeenCalledWith(7729, 1000);
    expect(result.recordsProcessed).toBe(0);
    const metadata = await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Customers' }).first();
    expect(metadata.continuation_token).toBeNull();
    expect(await db('raw_qbo_customers')).toHaveLength(0);
  });

  it('rejects a missing QueryResponse and a non-array Customer value', async () => {
    for (const response of [{}, { QueryResponse: { Customer: {} } }]) {
      const api = { getCustomersPage: jest.fn<(position: number, size: number) => Promise<any>>().mockResolvedValue(response) };
      await expect(new QboCustomerIngestionService(api).run()).rejects.toThrow('QuickBooks Customers ingestion failed.');
    }
  });
});
