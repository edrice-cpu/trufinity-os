import { afterAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { db } from '../../src/database';
import { errorHandler } from '../../src/middleware/error.middleware';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';

const VALID_TOKEN = 'valid-session-token-123';
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === VALID_TOKEN ? { sessionId: 's1', user: { id: 'u1', email: 'owner@trufinity.ca', fullName: null } } : null,
} as unknown as AuthService;

const app = express();
app.use('/api/reporting/servicetitan', createServiceTitanReportingRouter(fakeAuthService));
app.use(errorHandler);

const ROUTES = [
  '/summary',
  '/jobs/summary',
  '/invoices/summary',
  '/invoices/ar-aging',
  '/payments/summary',
  '/leads-bookings/summary',
  '/appointments/summary',
  '/customers/summary',
  '/technicians/summary',
  '/sync-status',
  '/jobs',
  '/invoices',
].map((path) => `/api/reporting/servicetitan${path}`);

afterAll(async () => {
  await db.destroy();
});

describe('ServiceTitan reporting routes auth', () => {
  it.each(ROUTES)('returns 401 for %s without a Bearer session', async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ status: 'error', message: 'Authentication required.' });
  });

  it.each(ROUTES)('returns 401 for %s with an unknown session token', async (path) => {
    const response = await request(app).get(path).set('Authorization', 'Bearer not-a-real-session-token');
    expect(response.status).toBe(401);
  });

  it.each(ROUTES)('returns 200 { status: "success" } for %s with a valid session', async (path) => {
    const response = await request(app).get(path).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('success');
  });
});
