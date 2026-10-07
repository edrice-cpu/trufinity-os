import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Knex } from 'knex';
import { QboApiClient } from '../../src/modules/quickbooks/api.client';
import { PostgresQboRefreshLock, QboAuthService, type QboRefreshLock, type QboTokenSet, type QboTokenStore } from '../../src/modules/quickbooks/auth.service';

class MemoryTokenStore implements QboTokenStore {
  public rejectSave = false;
  public constructor(public tokens: QboTokenSet | null) {}
  public async save(tokens: QboTokenSet): Promise<void> {
    if (this.rejectSave) throw new Error('mock persistence failure');
    this.tokens = { ...tokens };
  }
  public async load(): Promise<QboTokenSet | null> { return this.tokens ? { ...this.tokens } : null; }
  public async clear(): Promise<void> { this.tokens = null; }
}

class SharedMemoryRefreshLock implements QboRefreshLock {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  public async acquire(): Promise<() => Promise<void>> {
    if (this.held) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.held = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.held = false;
    };
  }
}

const noContentionLock: QboRefreshLock = { acquire: async () => async () => undefined };

const originalFetch = global.fetch;
const initialTokens = (): QboTokenSet => ({
  accessToken: 'test-access-old',
  refreshToken: 'test-refresh-old',
  realmId: 'test-realm',
  accessTokenExpiry: Date.now() + 60 * 60 * 1000,
  refreshTokenExpiry: Date.now() + 24 * 60 * 60 * 1000,
});

const unauthorized = (): Response => ({ ok: false, status: 401, text: async () => 'sensitive provider response' }) as Response;
const refreshed = (): Response => ({
  ok: true,
  status: 200,
  json: async () => ({
    access_token: 'test-access-new',
    refresh_token: 'test-refresh-rotated',
    expires_in: 3600,
    x_refresh_token_expires_in: 8640000,
  }),
}) as Response;
const success = (): Response => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('QuickBooks API authentication safety', () => {
  it('refreshes and retries once after a 401, persisting rotated credentials', async () => {
    const store = new MemoryTokenStore(initialTokens());
    const auth = new QboAuthService(store, noContentionLock);
    global.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(success());

    await expect(new QboApiClient(auth).get('/v3/company/test-realm/companyinfo/test-realm')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(store.tokens?.accessToken).toBe('test-access-new');
    expect(store.tokens?.refreshToken).toBe('test-refresh-rotated');
    expect(store.tokens?.accessTokenExpiry).toBeGreaterThan(Date.now());
    expect(store.tokens?.refreshTokenExpiry).toBeGreaterThan(store.tokens?.accessTokenExpiry ?? 0);
  });

  it('preserves persisted credentials when refresh fails after a 401', async () => {
    const original = initialTokens();
    const store = new MemoryTokenStore(original);
    const auth = new QboAuthService(store, noContentionLock);
    global.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'sensitive refresh response' } as Response);

    await expect(new QboApiClient(auth).get('/v3/company/test-realm/companyinfo/test-realm'))
      .rejects.toThrow('QuickBooks authentication refresh failed.');
    expect(store.tokens).toEqual(original);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('serializes two auth-service instances and reuses the token refreshed by the first', async () => {
    const expired = initialTokens();
    expired.accessTokenExpiry = Date.now() - 1;
    const store = new MemoryTokenStore(expired);
    const lock = new SharedMemoryRefreshLock();
    const firstAuth = new QboAuthService(store, lock);
    const secondAuth = new QboAuthService(store, lock);
    let markProviderStarted: () => void = () => undefined;
    let finishProviderRefresh: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const finishRefresh = new Promise<void>((resolve) => { finishProviderRefresh = resolve; });
    global.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
      markProviderStarted();
      await finishRefresh;
      return refreshed();
    });

    const first = firstAuth.getValidAccessToken();
    const second = secondAuth.getValidAccessToken();
    await providerStarted;
    finishProviderRefresh();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.accessToken).toBe('test-access-new');
    expect(secondResult.accessToken).toBe('test-access-new');
    expect(store.tokens?.refreshToken).toBe('test-refresh-rotated');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves credentials and does not call the provider if the refresh lock cannot be acquired', async () => {
    const lock: QboRefreshLock = { acquire: async () => { throw new Error('mock lock timeout'); } };
    const fetchSpy = jest.spyOn(global, 'fetch');

    const expired = { ...initialTokens(), accessTokenExpiry: Date.now() - 1 };
    const expiredStore = new MemoryTokenStore(expired);
    const expiredAuth = new QboAuthService(expiredStore, lock);
    await expect(expiredAuth.getValidAccessToken()).rejects.toThrow('mock lock timeout');
    expect(expiredStore.tokens).toEqual(expired);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses a dedicated PostgreSQL session lock and destroys its connection if unlock is not confirmed', async () => {
    const connection = {};
    const releaseConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const destroyRawConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const sqlCalls: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      client: { acquireConnection: async () => connection, releaseConnection, destroyRawConnection },
      raw: (sql: string, bindings: unknown[]) => ({
        connection: async () => {
          sqlCalls.push({ sql, bindings });
          return { rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [{ unlocked: false }] };
        },
      }),
    } as unknown as Knex;
    const release = await new PostgresQboRefreshLock(database).acquire();

    await expect(release()).rejects.toThrow('could not be safely released');
    expect(sqlCalls[0].sql).toContain('pg_try_advisory_lock');
    expect(sqlCalls[0].bindings).toEqual(['QuickBooks:OAuthTokenRefresh']);
    expect(sqlCalls[1].sql).toContain('pg_advisory_unlock');
    expect(destroyRawConnection).toHaveBeenCalledWith(connection);
    expect(releaseConnection).not.toHaveBeenCalled();
  });

  it('returns a lock connection to the pool after PostgreSQL confirms unlock', async () => {
    const connection = {};
    const releaseConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const destroyRawConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const database = {
      client: { acquireConnection: async () => connection, releaseConnection, destroyRawConnection },
      raw: (sql: string) => ({ connection: async () => ({ rows: [sql.includes('pg_try_advisory_lock') ? { locked: true } : { unlocked: true }] }) }),
    } as unknown as Knex;
    const release = await new PostgresQboRefreshLock(database).acquire();

    await release();
    await release();

    expect(releaseConnection).toHaveBeenCalledTimes(1);
    expect(releaseConnection).toHaveBeenCalledWith(connection);
    expect(destroyRawConnection).not.toHaveBeenCalled();
  });

  it('bounds advisory-lock waiting and releases a connection on timeout', async () => {
    const connection = {};
    const releaseConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const destroyRawConnection = jest.fn(async (..._args: unknown[]) => undefined);
    const database = {
      client: { acquireConnection: async () => connection, releaseConnection, destroyRawConnection },
      raw: () => ({ connection: async () => ({ rows: [{ locked: false }] }) }),
    } as unknown as Knex;

    await expect(new PostgresQboRefreshLock(database, 2, 0).acquire()).rejects.toThrow('timed out');
    expect(releaseConnection).toHaveBeenCalledWith(connection);
    expect(destroyRawConnection).not.toHaveBeenCalled();
  });

  it('does not replace in-memory or durable state when persistence of refreshed credentials fails', async () => {
    const original = initialTokens();
    original.accessTokenExpiry = Date.now() - 1;
    const store = new MemoryTokenStore(original);
    const auth = new QboAuthService(store, noContentionLock);
    store.rejectSave = true;
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce(refreshed()).mockResolvedValueOnce(refreshed());
    global.fetch = fetchMock;

    await expect(auth.getValidAccessToken()).rejects.toThrow('mock persistence failure');
    expect(store.tokens).toEqual(original);
    store.rejectSave = false;
    await auth.getValidAccessToken();

    const firstBody = fetchMock.mock.calls[0][1]?.body;
    const secondBody = fetchMock.mock.calls[1][1]?.body;
    expect(String(firstBody)).toContain('refresh_token=test-refresh-old');
    expect(String(secondBody)).toContain('refresh_token=test-refresh-old');
    expect(store.tokens?.refreshToken).toBe('test-refresh-rotated');
  });

  it('does not overwrite persisted credentials with an invalid successful token response', async () => {
    const original = initialTokens();
    const store = new MemoryTokenStore(original);
    const auth = new QboAuthService(store, noContentionLock);
    global.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: '', refresh_token: '   ', expires_in: 3600, x_refresh_token_expires_in: 8640000 }),
      } as Response);

    await expect(new QboApiClient(auth).get('/v3/company/test-realm/companyinfo/test-realm'))
      .rejects.toThrow('QuickBooks authentication refresh failed.');
    expect(store.tokens).toEqual(original);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves the rotated durable credentials if the one retry also returns 401', async () => {
    const store = new MemoryTokenStore(initialTokens());
    const auth = new QboAuthService(store, noContentionLock);
    global.fetch = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(unauthorized());

    await expect(new QboApiClient(auth).get('/v3/company/test-realm/companyinfo/test-realm'))
      .rejects.toMatchObject({ name: 'QboApiError', status: 401 });
    expect(store.tokens?.accessToken).toBe('test-access-new');
    expect(store.tokens?.refreshToken).toBe('test-refresh-rotated');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('clears only in-memory cache when clearCache is called', async () => {
    const original = initialTokens();
    const store = new MemoryTokenStore(original);
    const auth = new QboAuthService(store, noContentionLock);
    await auth.getValidAccessToken();

    await auth.clearCache();

    expect(store.tokens).toEqual(original);
  });
});
