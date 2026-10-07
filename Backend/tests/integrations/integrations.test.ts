import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { env } from '../../src/config/env';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createIntegrationsRouter } from '../../src/modules/integrations/integrations.routes';
import { IntegrationsService } from '../../src/modules/integrations/integrations.service';
import { qboApiClient } from '../../src/modules/quickbooks/api.client';
import { qboAuthService } from '../../src/modules/quickbooks/auth.service';
import { quickbooksRouter } from '../../src/modules/quickbooks/quickbooks.routes';

const VALID_TOKEN = 'valid-session-token-123';
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === VALID_TOKEN ? { sessionId: 's1', user: { id: 'u1', email: 'owner@trufinity.ca', fullName: null } } : null,
} as unknown as AuthService;

const fakeDatabase = (companyName: string | null) =>
  Object.assign(
    () => ({ where: () => ({ first: async () => (companyName ? { company_name: companyName } : undefined) }) }),
    { raw: (sql: string) => sql },
  ) as never;

const buildApp = (service: IntegrationsService) => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', createIntegrationsRouter(service, fakeAuthService));
  return app;
};

describe('Integrations routes', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('requires an authenticated session', async () => {
    const app = buildApp(new IntegrationsService());
    expect((await request(app).get('/api/integrations/status')).status).toBe(401);
    expect((await request(app).post('/api/integrations/quickbooks/connect')).status).toBe(401);
  });

  it('reports QuickBooks as connected from durable tokens without exposing them', async () => {
    const expiry = Date.now() + 86_400_000;
    const qbo = {
      isConfigured: () => true,
      getConnection: async () => ({ realmId: 'realm-1', refreshTokenExpiry: expiry }),
      getAuthorizationUrl: () => 'unused',
    };
    const serviceTitan = { getAccessToken: jest.fn(async () => 'token') };
    // Pin ServiceTitan to "unconfigured" so the result doesn't depend on the local .env.
    jest.replaceProperty(env, 'SERVICETITAN_CLIENT_ID', '');
    const app = buildApp(new IntegrationsService(qbo, serviceTitan, fakeDatabase('Trufinity Plumbing')));

    const res = await request(app).get('/api/integrations/status').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.quickbooks).toEqual({
      configured: true, connected: true, realmId: 'realm-1', companyName: 'Trufinity Plumbing',
      refreshTokenExpiresAt: new Date(expiry).toISOString(),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/access_?token|refresh_?token"/i);
    // With ServiceTitan credentials unset, no token request is attempted.
    expect(res.body.servicetitan).toMatchObject({ configured: false, connected: false, connectUrl: env.SERVICETITAN_CONNECT_URL });
    expect(serviceTitan.getAccessToken).not.toHaveBeenCalled();
  });

  it('reports ServiceTitan as connected only when configured credentials mint a token', async () => {
    for (const key of ['SERVICETITAN_CLIENT_ID', 'SERVICETITAN_CLIENT_SECRET', 'SERVICETITAN_APP_KEY',
      'SERVICETITAN_AUTH_URL', 'SERVICETITAN_BASE_URL', 'SERVICETITAN_TENANT_ID'] as const) {
      jest.replaceProperty(env, key, 'configured-value');
    }
    const qbo = { isConfigured: () => false, getConnection: async () => null, getAuthorizationUrl: () => 'unused' };

    const working = await request(buildApp(new IntegrationsService(qbo, { getAccessToken: async () => 'token' })))
      .get('/api/integrations/status').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(working.body.servicetitan).toMatchObject({ configured: true, connected: true });

    const rejected = await request(buildApp(new IntegrationsService(qbo, { getAccessToken: async () => { throw new Error('401'); } })))
      .get('/api/integrations/status').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(rejected.body.servicetitan).toMatchObject({ configured: true, connected: false });
  });

  it('treats an expired refresh token as disconnected', async () => {
    const qbo = {
      isConfigured: () => true,
      getConnection: async () => ({ realmId: 'realm-1', refreshTokenExpiry: Date.now() - 1000 }),
      getAuthorizationUrl: () => 'unused',
    };
    const app = buildApp(new IntegrationsService(qbo, { getAccessToken: async () => 'x' }, fakeDatabase(null)));
    const res = await request(app).get('/api/integrations/status').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.body.quickbooks.connected).toBe(false);
  });

  it('returns an app-bound QuickBooks authorization URL, or 503 when not configured', async () => {
    const getAuthorizationUrl = jest.fn((_options?: { returnToApp?: boolean }) => 'https://appcenter.intuit.com/connect/oauth2?state=abc');
    const configured = { isConfigured: () => true, getConnection: async () => null, getAuthorizationUrl };
    const res = await request(buildApp(new IntegrationsService(configured, { getAccessToken: async () => 'x' })))
      .post('/api/integrations/quickbooks/connect').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBe('https://appcenter.intuit.com/connect/oauth2?state=abc');
    expect(getAuthorizationUrl).toHaveBeenCalledWith({ returnToApp: true });

    const unconfigured = { ...configured, isConfigured: () => false };
    const res503 = await request(buildApp(new IntegrationsService(unconfigured, { getAccessToken: async () => 'x' })))
      .post('/api/integrations/quickbooks/connect').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res503.status).toBe(503);
  });
});

describe('QuickBooks OAuth callback', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  const app = express();
  app.use('/api/integrations/quickbooks', quickbooksRouter);
  const stateFrom = (url: string) => new URL(url, 'https://x.test').searchParams.get('state') ?? '';

  it('redirects app-initiated flows back to the Integrations page', async () => {
    jest.spyOn(qboAuthService, 'exchangeCodeForToken').mockResolvedValue();
    jest.spyOn(qboApiClient, 'get').mockResolvedValue({ CompanyInfo: { CompanyName: 'Co' } });
    const state = stateFrom(qboAuthService.getAuthorizationUrl({ returnToApp: true }));

    const res = await request(app).get(`/api/integrations/quickbooks/callback?code=c&realmId=r&state=${state}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${env.APP_BASE_URL}/integrations?quickbooks=connected`);
  });

  it('redirects with a denied result when the user declines in Intuit', async () => {
    const state = stateFrom(qboAuthService.getAuthorizationUrl({ returnToApp: true }));
    const res = await request(app).get(`/api/integrations/quickbooks/callback?error=access_denied&state=${state}`);
    expect(res.headers.location).toBe(`${env.APP_BASE_URL}/integrations?quickbooks=denied`);
  });

  it('redirects with a failed result when the token exchange fails', async () => {
    jest.spyOn(qboAuthService, 'exchangeCodeForToken').mockRejectedValue(new Error('boom'));
    const state = stateFrom(qboAuthService.getAuthorizationUrl({ returnToApp: true }));
    const res = await request(app).get(`/api/integrations/quickbooks/callback?code=c&realmId=r&state=${state}`);
    expect(res.headers.location).toBe(`${env.APP_BASE_URL}/integrations?quickbooks=failed`);
  });

  it('keeps the JSON response for flows started directly via /authorize', async () => {
    jest.spyOn(qboAuthService, 'exchangeCodeForToken').mockResolvedValue();
    jest.spyOn(qboApiClient, 'get').mockResolvedValue({ CompanyInfo: { CompanyName: 'Co' } });
    const state = stateFrom(qboAuthService.getAuthorizationUrl());
    const res = await request(app).get(`/api/integrations/quickbooks/callback?code=c&realmId=r&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'success', company: 'Co' });
  });

  it('rejects unknown or replayed state', async () => {
    const state = stateFrom(qboAuthService.getAuthorizationUrl({ returnToApp: true }));
    jest.spyOn(qboAuthService, 'exchangeCodeForToken').mockResolvedValue();
    jest.spyOn(qboApiClient, 'get').mockResolvedValue({});
    await request(app).get(`/api/integrations/quickbooks/callback?code=c&realmId=r&state=${state}`);
    const replay = await request(app).get(`/api/integrations/quickbooks/callback?code=c&realmId=r&state=${state}`);
    expect(replay.status).toBe(400);
  });
});
