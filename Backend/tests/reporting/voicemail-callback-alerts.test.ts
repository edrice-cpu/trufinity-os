// jest.mock must be hoisted above all imports.
jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-st-token' },
}));
// Mock the entire reporting service so the route handler never touches the DB.
// listVoicemailCallbackAlerts is a jest.fn() so individual tests can override it.
jest.mock('../../src/modules/reporting/servicetitan-reporting.service', () => ({
  serviceTitanReportingService: {
    getSnapshot: jest.fn(async () => ({})),
    getJobsSummary: jest.fn(async () => ({})),
    getInvoicesSummary: jest.fn(async () => ({})),
    getArAging: jest.fn(async () => ({})),
    getPaymentsSummary: jest.fn(async () => ({})),
    getLeadsBookingsSummary: jest.fn(async () => ({})),
    getAppointmentsSummary: jest.fn(async () => ({})),
    getCustomersSummary: jest.fn(async () => ({})),
    getTechnicianSummary: jest.fn(async () => ({})),
    getSyncStatus: jest.fn(async () => ({})),
    listJobs: jest.fn(async () => ({ data: [], total: 0 })),
    listInvoices: jest.fn(async () => ({ data: [], total: 0 })),
    listAbandonedCalls: jest.fn(async () => ({ data: [], totalCount: 0, page: 1, pageSize: 25 })),
    getAbandonedCallsAggregate: jest.fn(async () => ({ totalCount: 0, withVoicemail: 0, withCustomerId: 0, byDay: [], byHour: [] })),
    listVoicemailCallbackAlerts: jest.fn(async () => ({ data: [], totalCount: 0, page: 1, pageSize: 25 })),
  },
}));

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Application } from 'express';
import request from 'supertest';
import { db } from '../../src/database';
import { errorHandler } from '../../src/middleware/error.middleware';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';
import { serviceTitanReportingService as mockService } from '../../src/modules/reporting/servicetitan-reporting.service';
import type { VoicemailCallbackAlertItem } from '../../src/modules/reporting/servicetitan-reporting.types';

const VALID_TOKEN = 'valid-session-token-voicemail-test';
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === VALID_TOKEN
      ? { sessionId: 's1', user: { id: 'u1', email: 'owner@trufinity.ca', fullName: null } }
      : null,
} as unknown as AuthService;

const ENDPOINT = '/api/reporting/servicetitan/telecom/alerts/voicemail-callbacks';

function buildApp(): Application {
  const app = express();
  app.use('/api/reporting/servicetitan', createServiceTitanReportingRouter(undefined, fakeAuthService));
  app.use(errorHandler);
  return app;
}

const sampleAlert = (overrides: Partial<VoicemailCallbackAlertItem> = {}): VoicemailCallbackAlertItem => ({
  sourceId: '123456',
  status: 'OPEN',
  voicemailAt: '2026-10-10T14:00:00.000Z',
  thresholdMinutes: 60,
  businessMinutesElapsed: 45,
  thresholdExceededAt: null,
  callbackAt: null,
  updatedAt: '2026-10-10T14:45:00.000Z',
  ...overrides,
});

const mockedList = mockService.listVoicemailCallbackAlerts as jest.MockedFunction<
  typeof mockService.listVoicemailCallbackAlerts
>;

let app: Application;

beforeEach(() => {
  app = buildApp();
  mockedList.mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 25 });
});

afterAll(async () => {
  if (typeof (db as { destroy?: () => Promise<void> }).destroy === 'function') {
    await db.destroy();
  }
});

// ─── Authentication ───────────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — authentication', () => {
  it('returns 401 without a Bearer session token', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(401);
    expect((res.body as { status: string }).status).toBe('error');
  });

  it('returns 401 with an unknown token', async () => {
    const res = await request(app).get(ENDPOINT).set('Authorization', 'Bearer unknown-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid session token', async () => {
    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('success');
  });
});

// ─── Status filter validation ────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — status filter', () => {
  it('returns 400 for an invalid status', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?status=INVALID`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/OPEN.*RESOLVED.*UNVERIFIABLE/);
  });

  it('accepts OPEN status', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?status=OPEN`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), 'OPEN', undefined, undefined,
    );
  });

  it('accepts RESOLVED status', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?status=RESOLVED`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), 'RESOLVED', undefined, undefined,
    );
  });

  it('accepts UNVERIFIABLE status', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?status=UNVERIFIABLE`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), 'UNVERIFIABLE', undefined, undefined,
    );
  });

  it('omits status when not provided (returns all statuses)', async () => {
    const res = await request(app)
      .get(ENDPOINT)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), undefined, undefined, undefined,
    );
  });
});

// ─── Date range validation ────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — date range', () => {
  it('returns 400 for a non-ISO from value', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?from=not-a-date`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/from/);
  });

  it('returns 400 for a non-ISO to value', async () => {
    const res = await request(app)
      .get(`${ENDPOINT}?to=not-a-date`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/to/);
  });

  it('passes valid from/to dates to the service', async () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-14T00:00:00.000Z';
    const res = await request(app)
      .get(`${ENDPOINT}?from=${from}&to=${to}`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const call = mockedList.mock.calls[0]!;
    expect((call[3] as Date).toISOString()).toBe(from);
    expect((call[4] as Date).toISOString()).toBe(to);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — pagination', () => {
  it('defaults to page 1, pageSize 25', async () => {
    await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(mockedList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined);
  });

  it('respects explicit page and pageSize', async () => {
    await request(app)
      .get(`${ENDPOINT}?page=3&pageSize=10`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(mockedList).toHaveBeenCalledWith(3, 10, undefined, undefined, undefined);
  });

  it('clamps pageSize to 100', async () => {
    await request(app)
      .get(`${ENDPOINT}?pageSize=9999`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(mockedList).toHaveBeenCalledWith(1, 100, undefined, undefined, undefined);
  });

  it('clamps page to minimum 1 for non-positive values', async () => {
    await request(app)
      .get(`${ENDPOINT}?page=0`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(mockedList).toHaveBeenCalledWith(1, 25, undefined, undefined, undefined);
  });

  it('returns pagination envelope with totalCount', async () => {
    mockedList.mockResolvedValueOnce({
      page: 2,
      pageSize: 10,
      totalCount: 42,
      data: [],
    });
    const res = await request(app)
      .get(`${ENDPOINT}?page=2&pageSize=10`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const body = res.body as { status: string; page: number; pageSize: number; totalCount: number };
    expect(body.status).toBe('success');
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(10);
    expect(body.totalCount).toBe(42);
  });
});

// ─── Empty results ────────────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — empty results', () => {
  it('returns success with empty data array when no alerts exist', async () => {
    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const body = res.body as { status: string; data: unknown[]; totalCount: number };
    expect(body.status).toBe('success');
    expect(body.data).toEqual([]);
    expect(body.totalCount).toBe(0);
  });
});

// ─── Response shape and privacy ──────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — response shape', () => {
  it('returns all expected fields and no PII fields', async () => {
    const alert = sampleAlert({ status: 'OPEN' });
    mockedList.mockResolvedValueOnce({ page: 1, pageSize: 25, totalCount: 1, data: [alert] });

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);

    const body = res.body as { data: Record<string, unknown>[] };
    const item = body.data[0]!;

    expect(item['sourceId']).toBe('123456');
    expect(item['status']).toBe('OPEN');
    expect(item['voicemailAt']).toBe('2026-10-10T14:00:00.000Z');
    expect(item['thresholdMinutes']).toBe(60);
    expect(item['businessMinutesElapsed']).toBe(45);
    expect(item['thresholdExceededAt']).toBeNull();
    expect(item['callbackAt']).toBeNull();
    expect(item['updatedAt']).toBe('2026-10-10T14:45:00.000Z');

    // Privacy: no PII fields should appear
    expect(item).not.toHaveProperty('phone');
    expect(item).not.toHaveProperty('customerPhone');
    expect(item).not.toHaveProperty('recordingUrl');
    expect(item).not.toHaveProperty('voiceMailUrl');
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('stCustomerId');
  });

  it('returns thresholdExceededAt as ISO string for OPEN alerts past SLA', async () => {
    const alert = sampleAlert({ thresholdExceededAt: '2026-10-10T16:00:00.000Z', businessMinutesElapsed: 80 });
    mockedList.mockResolvedValueOnce({ page: 1, pageSize: 25, totalCount: 1, data: [alert] });

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    const item = (res.body as { data: Record<string, unknown>[] }).data[0]!;
    expect(item['thresholdExceededAt']).toBe('2026-10-10T16:00:00.000Z');
  });

  it('returns callbackAt for RESOLVED alerts', async () => {
    const alert = sampleAlert({
      status: 'RESOLVED',
      callbackAt: '2026-10-10T15:30:00.000Z',
    });
    mockedList.mockResolvedValueOnce({ page: 1, pageSize: 25, totalCount: 1, data: [alert] });

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    const item = (res.body as { data: Record<string, unknown>[] }).data[0]!;
    expect(item['status']).toBe('RESOLVED');
    expect(item['callbackAt']).toBe('2026-10-10T15:30:00.000Z');
  });

  it('returns UNVERIFIABLE status correctly', async () => {
    const alert = sampleAlert({ status: 'UNVERIFIABLE' });
    mockedList.mockResolvedValueOnce({ page: 1, pageSize: 25, totalCount: 1, data: [alert] });

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    const item = (res.body as { data: Record<string, unknown>[] }).data[0]!;
    expect(item['status']).toBe('UNVERIFIABLE');
  });
});

// ─── Database failure ─────────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — error handling', () => {
  it('returns 500 when the database query throws', async () => {
    mockedList.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(500);
  });
});

// ─── Deterministic sorting ────────────────────────────────────────────────────

describe('GET /telecom/alerts/voicemail-callbacks — sorting', () => {
  it('receives data in the order returned by the service (voicemail_at DESC)', async () => {
    const alerts = [
      sampleAlert({ sourceId: '300', voicemailAt: '2026-10-12T10:00:00.000Z' }),
      sampleAlert({ sourceId: '200', voicemailAt: '2026-10-11T10:00:00.000Z' }),
      sampleAlert({ sourceId: '100', voicemailAt: '2026-10-10T10:00:00.000Z' }),
    ];
    mockedList.mockResolvedValueOnce({ page: 1, pageSize: 25, totalCount: 3, data: alerts });

    const res = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${VALID_TOKEN}`);
    const body = res.body as { data: Array<{ sourceId: string }> };
    expect(body.data.map((a) => a.sourceId)).toEqual(['300', '200', '100']);
  });
});
