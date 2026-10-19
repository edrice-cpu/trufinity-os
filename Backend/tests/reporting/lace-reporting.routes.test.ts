import { afterAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { db } from '../../src/database';
import { errorHandler } from '../../src/middleware/error.middleware';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createLaceReportingRouter } from '../../src/modules/reporting/lace-reporting.routes';

const VALID_TOKEN = 'valid-session-token-123';
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === VALID_TOKEN ? { sessionId: 's1', user: { id: 'u1', email: 'owner@trufinity.ca', fullName: null } } : null,
} as unknown as AuthService;

const app = express();
app.use('/api/reporting/lace', createLaceReportingRouter(fakeAuthService));
app.use(errorHandler);

afterAll(async () => {
  await db.destroy();
});

describe('GET /api/reporting/lace/sync-status', () => {
  it('returns 401 without a session', async () => {
    const response = await request(app).get('/api/reporting/lace/sync-status');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ status: 'error', message: 'Authentication required.' });
  });

  it('returns one health entry per Lace feed with a status', async () => {
    const response = await request(app).get('/api/reporting/lace/sync-status').set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(response.status).toBe(200);
    const body = response.body as { status: string; data: { exportType: string; status: string }[] };
    expect(body.status).toBe('success');
    expect(body.data.map((d) => d.exportType)).toEqual(['call_analysis', 'agent_performance']);
    for (const entry of body.data) expect(['OK', 'STALE', 'FAILING', 'NO_DATA']).toContain(entry.status);
  });
});
