import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { env } from '../../src/config/env';
import { QboAuthService, type QboRefreshLock, type QboTokenSet, type QboTokenStore, qboAuthService } from '../../src/modules/quickbooks/auth.service';
import { quickbooksRouter } from '../../src/modules/quickbooks/quickbooks.routes';

class MemoryTokenStore implements QboTokenStore {
  public tokens: QboTokenSet | null;
  public constructor(initial: QboTokenSet | null) { this.tokens = initial; }
  public async save(tokens: QboTokenSet): Promise<void> { this.tokens = { ...tokens }; }
  public async load(): Promise<QboTokenSet | null> { return this.tokens ? { ...this.tokens } : null; }
  public async clear(): Promise<void> { this.tokens = null; }
}

const noContentionLock: QboRefreshLock = { acquire: async () => async () => undefined };

const originalFetch = global.fetch;
const originalDisconnectToken = env.QBO_DISCONNECT_AUTH_TOKEN;

afterEach(() => {
  global.fetch = originalFetch;
  env.QBO_DISCONNECT_AUTH_TOKEN = originalDisconnectToken;
  jest.restoreAllMocks();
});

describe('QuickBooks OAuth token lifecycle', () => {
  it('GET disconnect never calls revocation; POST requires the configured bearer secret', async () => {
    env.QBO_DISCONNECT_AUTH_TOKEN = 'test-admin-secret-0123456789abcdef';
    const disconnectSpy = jest.spyOn(qboAuthService, 'disconnect').mockResolvedValue(true);
    const app = express().use('/api/integrations/quickbooks', quickbooksRouter);

    const getResponse = await request(app).get('/api/integrations/quickbooks/disconnect');
    expect(getResponse.status).toBe(405);
    expect(disconnectSpy).not.toHaveBeenCalled();

    const unauthenticatedPost = await request(app).post('/api/integrations/quickbooks/disconnect');
    expect(unauthenticatedPost.status).toBe(401);
    expect(disconnectSpy).not.toHaveBeenCalled();

    const authorizedPost = await request(app)
      .post('/api/integrations/quickbooks/disconnect')
      .set('Authorization', 'Bearer test-admin-secret-0123456789abcdef');
    expect(authorizedPost.status).toBe(200);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not clear stored credentials if Intuit revocation fails', async () => {
    const stored: QboTokenSet = {
      accessToken: 'safe-test-access-token',
      refreshToken: 'safe-test-refresh-token',
      realmId: 'test-realm',
      accessTokenExpiry: Date.now() + 60_000,
      refreshTokenExpiry: Date.now() + 86_400_000,
    };
    const tokenStore = new MemoryTokenStore(stored);
    const service = new QboAuthService(tokenStore, noContentionLock);
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'provider response must not be logged',
    } as Response);

    await expect(service.disconnect()).rejects.toThrow('QuickBooks disconnect failed.');
    expect(tokenStore.tokens).toEqual(stored);
  });

  it('clears stored credentials only after successful Intuit revocation', async () => {
    const tokenStore = new MemoryTokenStore({
      accessToken: 'safe-test-access-token',
      refreshToken: 'safe-test-refresh-token',
      realmId: 'test-realm',
      accessTokenExpiry: Date.now() + 60_000,
      refreshTokenExpiry: Date.now() + 86_400_000,
    });
    const service = new QboAuthService(tokenStore, noContentionLock);
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({ ok: true, status: 200 } as Response);

    await expect(service.disconnect()).resolves.toBe(true);
    expect(tokenStore.tokens).toBeNull();
  });

  it('persists rotated tokens and both refreshed expiry values', async () => {
    const tokenStore = new MemoryTokenStore({
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      realmId: 'test-realm',
      accessTokenExpiry: Date.now() - 1,
      refreshTokenExpiry: Date.now() + 86_400_000,
    });
    const service = new QboAuthService(tokenStore, noContentionLock);
    const beforeRefresh = Date.now();
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        x_refresh_token_expires_in: 8640000,
      }),
    } as Response);

    const result = await service.getValidAccessToken();
    expect(result).toEqual({ accessToken: 'new-access-token', realmId: 'test-realm' });
    expect(tokenStore.tokens?.accessToken).toBe('new-access-token');
    expect(tokenStore.tokens?.refreshToken).toBe('rotated-refresh-token');
    expect(tokenStore.tokens?.accessTokenExpiry).toBeGreaterThanOrEqual(beforeRefresh + 3_599_000);
    expect(tokenStore.tokens?.refreshTokenExpiry).toBeGreaterThanOrEqual(beforeRefresh + 8_639_000);
  });
});
