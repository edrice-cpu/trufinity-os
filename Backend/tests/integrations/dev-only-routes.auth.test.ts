import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Router } from 'express';
import request from 'supertest';

// The dev-only routers import the module-level requireAuth, so the auth
// service it closes over is swapped for one that knows a single valid token.
const VALID_TOKEN = 'valid-session-token-123';
jest.mock('../../src/modules/auth/auth.service', () => {
  const actual = jest.requireActual<typeof import('../../src/modules/auth/auth.service')>('../../src/modules/auth/auth.service');
  return {
    ...actual,
    authService: {
      authenticate: async (token: string) =>
        token === VALID_TOKEN ? { sessionId: 's1', user: { id: 'u1', email: 'dev@trufinity.ca', fullName: null } } : null,
    },
  };
});

import { env } from '../../src/config/env';
import { db } from '../../src/database';
import { detectRouter } from '../../src/modules/detect/detect.routes';
import { detectService } from '../../src/modules/detect/detect.service';
import { laceRouter } from '../../src/modules/lace/lace.routes';
import { narrateRouter } from '../../src/modules/narrate/narrate.routes';
import { quickbooksRouter } from '../../src/modules/quickbooks/quickbooks.routes';
import { serviceTitanRouter } from '../../src/modules/servicetitan/servicetitan.routes';

const ROUTES: [string, Router, 'get' | 'post', string][] = [
  ['/api/integrations/servicetitan', serviceTitanRouter, 'get', '/jobs'],
  ['/api/integrations/servicetitan', serviceTitanRouter, 'post', '/sync/business-units'],
  ['/api/integrations/quickbooks', quickbooksRouter, 'get', '/customers'],
  ['/api/integrations/lace', laceRouter, 'post', '/sync/call-analysis'],
  ['/api/detect', detectRouter, 'post', '/run'],
  ['/api/narrate', narrateRouter, 'post', '/run'],
];

const buildApp = (prefix: string, router: Router) => express().use(prefix, router);

describe('dev-only routers', () => {
  const originalNodeEnv = env.NODE_ENV;
  afterEach(() => { env.NODE_ENV = originalNodeEnv; jest.restoreAllMocks(); });
  afterAll(async () => { await db.destroy(); });

  it.each(ROUTES)('%s%s (%s %s) stays 403 outside development', async (prefix, router, method, path) => {
    env.NODE_ENV = 'production';
    const res = await request(buildApp(prefix, router))[method](`${prefix}${path}`).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)('%s (%s %s) needs a signed-in session even in development', async (prefix, router, method, path) => {
    env.NODE_ENV = 'development';
    const res = await request(buildApp(prefix, router))[method](`${prefix}${path}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'error', message: 'Authentication required.' });
  });

  it('lets a signed-in request through to the handler in development', async () => {
    env.NODE_ENV = 'development';
    jest.spyOn(detectService, 'run').mockResolvedValue({ findings: [] });
    const res = await request(buildApp('/api/detect', detectRouter)).post('/api/detect/run').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ findings: [] });
  });
});

