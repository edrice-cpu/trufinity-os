import { describe, expect, it, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import { QboCompanyInfoIngestionService } from '../../src/modules/quickbooks/ingestion/companyinfo.ingestion';

describe('QBO CompanyInfo raw ingestion', () => {
  beforeEach(async () => {
    await db('raw_qbo_companyinfo').delete();
    await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CompanyInfo' }).delete();
  });

  afterAll(async () => {
    await db('raw_qbo_companyinfo').delete();
    await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CompanyInfo' }).delete();
    await db.destroy();
  });

  it('persists the complete payload and tracks a full refresh', async () => {
    const payload = { Id: 'company-1', CompanyName: 'Example', nested: { enabled: true } };
    const api = { getCompanyInfo: jest.fn<() => Promise<unknown>>().mockResolvedValue(payload) };
    const result = await new QboCompanyInfoIngestionService(api).run();
    const row = await db('raw_qbo_companyinfo').where({ source_id: 'company-1' }).first();
    const run = await db('sync_runs').where({ id: result.syncRunId }).first();
    const metadata = await db('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CompanyInfo' }).first();
    expect(row.payload).toEqual(payload);
    expect(row.is_latest).toBe(true);
    expect(run.status).toBe('COMPLETED');
    expect(metadata.continuation_token).toBeNull();
    expect(metadata.last_synced_at).toBeTruthy();
  });
});
