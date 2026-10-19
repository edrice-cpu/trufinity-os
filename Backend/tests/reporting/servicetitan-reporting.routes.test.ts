// jest.mock must be hoisted above all imports.
jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-st-token' },
}));
// Mock the reporting service so routes return 200 without a real database.
// This test validates auth behaviour; service response content is not under test here.
jest.mock('../../src/modules/reporting/servicetitan-reporting.service', () => ({
  serviceTitanReportingService: {
    getSnapshot: async () => ({}),
    getJobsSummary: async () => ({}),
    getInvoicesSummary: async () => ({}),
    getArAging: async () => ({}),
    getPaymentsSummary: async () => ({}),
    getLeadsBookingsSummary: async () => ({}),
    getAppointmentsSummary: async () => ({}),
    getCustomersSummary: async () => ({}),
    getTechnicianSummary: async () => ({}),
    getSyncStatus: async () => ({}),
    listJobs: async () => ({ data: [], total: 0 }),
    listInvoices: async () => ({ data: [], total: 0 }),
    listAbandonedCalls: async () => ({ data: [], totalCount: 0, page: 1, pageSize: 25 }),
    getAbandonedCallsAggregate: async () => ({ totalCount: 0, withVoicemail: 0, withCustomerId: 0, byDay: [], byHour: [] }),
    listVoicemailCallbackAlerts: async () => ({ data: [], totalCount: 0, page: 1, pageSize: 25 }),
    getAgentMetrics: async () => ({ data: [], totalCount: 0, page: 1, pageSize: 25 }),
    getCallRevenueAttribution: async () => ({
      callId: '1', attributionStatus: 'NO_LINKAGE', attributionMethod: 'none',
      customerId: null, jobId: null, linkedInvoiceCount: 0,
      invoicedAmount: null, outstandingBalance: null, currency: null,
    }),
  },
}));

import { afterAll, describe, expect, it, jest } from '@jest/globals';
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
// recordingService and callDetailsService use their defaults (mocked ST auth above).
// This test only exercises auth behaviour and standard reporting routes.
app.use('/api/reporting/servicetitan', createServiceTitanReportingRouter(undefined, fakeAuthService));
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
  '/telecom/calls/1234567890/revenue',
  '/telecom/agents/metrics',
].map((path) => `/api/reporting/servicetitan${path}`);

afterAll(async () => {
  // db is mocked as {}; destroy is a no-op in this test environment.
  if (typeof (db as { destroy?: () => Promise<void> }).destroy === 'function') {
    await db.destroy();
  }
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
