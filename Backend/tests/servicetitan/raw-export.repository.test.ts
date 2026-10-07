import { describe, expect, it, jest } from '@jest/globals';
import { PostgresServiceTitanRawRepository, type RawIngestionConfig } from '../../src/modules/servicetitan/ingestion/raw-export.ingestion';

const config: RawIngestionConfig = {
  sourceSystem: 'ServiceTitan', entityType: 'Test', rawTable: 'raw_st_customers',
  exportEndpoint: '/unused', lockKey: 'test-lock',
};

function fakeDatabase(unlockError = false) {
  const releaseConnection = jest.fn(async () => undefined);
  const connection = {};
  const database = {
    client: { acquireConnection: jest.fn(async () => connection), releaseConnection, destroyRawConnection: jest.fn(async () => undefined) },
    raw: jest.fn((sql: string) => ({
      connection: jest.fn(async () => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (unlockError) throw new Error('unlock failed');
        return { rows: [{ unlocked: true }] };
      }),
    })),
  };
  return { database, releaseConnection };
}

describe('raw ingestion advisory-lock cleanup', () => {
  it('releases the connection when unlock fails after success', async () => {
    const { database, releaseConnection } = fakeDatabase(true);
    const repository = new PostgresServiceTitanRawRepository(config, database as never);
    await expect(repository.withExclusiveLock(async () => 'ok')).resolves.toBe('ok');
    expect(releaseConnection).toHaveBeenCalledTimes(1);
  });

  it('releases the connection when the protected operation fails', async () => {
    const { database, releaseConnection } = fakeDatabase();
    const repository = new PostgresServiceTitanRawRepository(config, database as never);
    await expect(repository.withExclusiveLock(async () => { throw new Error('work failed'); })).rejects.toThrow('work failed');
    expect(releaseConnection).toHaveBeenCalledTimes(1);
  });
});
