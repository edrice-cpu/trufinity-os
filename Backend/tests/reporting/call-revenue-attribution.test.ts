// Call-to-Revenue Attribution API tests
//
// All service calls are served by the mock below — no real database or ST API.
// Tests verify: auth guard, call ID validation, attribution status shapes,
// revenue field accuracy, PII exclusion, and DB failure handling.

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-st-token' },
}));
jest.mock('../../src/modules/reporting/servicetitan-reporting.service', () => ({
  serviceTitanReportingService: {
    // Return type is explicitly CallRevenueAttribution — cast needed because jest.fn is untyped here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCallRevenueAttribution: jest.fn(async (): Promise<any> => ({
      callId: '123',
      attributionStatus: 'NO_LINKAGE' as const,
      attributionMethod: 'none' as const,
      customerId: null,
      jobId: null,
      linkedInvoiceCount: 0,
      invoicedAmount: null,
      outstandingBalance: null,
      currency: null,
    })),
  },
}));

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { db } from '../../src/database';
import { errorHandler } from '../../src/middleware/error.middleware';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';
import type { CallRevenueAttribution } from '../../src/modules/reporting/servicetitan-reporting.types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serviceTitanReportingService: mockService } = require('../../src/modules/reporting/servicetitan-reporting.service') as {
  serviceTitanReportingService: {
    getCallRevenueAttribution: jest.MockedFunction<(callId: string) => Promise<CallRevenueAttribution>>;
  }
};

const VALID_TOKEN = 'valid-session-token';
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === VALID_TOKEN
      ? { sessionId: 's1', user: { id: 'u1', email: 'owner@trufinity.ca', fullName: null } }
      : null,
} as unknown as AuthService;

const app = express();
app.use('/api/reporting/servicetitan', createServiceTitanReportingRouter(undefined, fakeAuthService));
app.use(errorHandler);

const BASE = '/api/reporting/servicetitan/telecom/calls';

afterAll(async () => {
  if (typeof (db as { destroy?: () => Promise<void> }).destroy === 'function') {
    await db.destroy();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authed() {
  return request(app).get(`${BASE}/9876543210/revenue`).set('Authorization', `Bearer ${VALID_TOKEN}`);
}

function noJobAttribution(callId = '9876543210'): CallRevenueAttribution {
  return {
    callId,
    attributionStatus: 'NO_JOB',
    attributionMethod: 'none',
    customerId: 'cust-42',
    jobId: null,
    linkedInvoiceCount: 0,
    invoicedAmount: null,
    outstandingBalance: null,
    currency: null,
  };
}

function jobLinkedAttribution(callId = '9876543210'): CallRevenueAttribution {
  return {
    callId,
    attributionStatus: 'JOB_LINKED',
    attributionMethod: 'call_job_invoice',
    customerId: 'cust-42',
    jobId: 'job-99',
    linkedInvoiceCount: 2,
    invoicedAmount: '1500.00',
    outstandingBalance: '350.00',
    currency: 'USD',
  };
}

// ─── Authentication ────────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — authentication', () => {
  it('returns 401 without a Bearer token', async () => {
    const res = await request(app).get(`${BASE}/12345/revenue`);
    expect(res.status).toBe(401);
    expect((res.body as { status: string }).status).toBe('error');
  });

  it('returns 401 with an invalid session token', async () => {
    const res = await request(app)
      .get(`${BASE}/12345/revenue`)
      .set('Authorization', 'Bearer not-real');
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid session token', async () => {
    const res = await authed();
    expect(res.status).toBe(200);
  });
});

// ─── Call ID validation ────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — call ID validation', () => {
  it('returns 400 for a non-numeric call ID', async () => {
    const res = await request(app)
      .get(`${BASE}/not-a-number/revenue`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/Invalid call ID/i);
  });

  it('returns 400 for a call ID that exceeds 20 digits', async () => {
    const tooLong = '1'.repeat(21);
    const res = await request(app)
      .get(`${BASE}/${tooLong}/revenue`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it('accepts a 1-digit call ID', async () => {
    mockService.getCallRevenueAttribution.mockResolvedValueOnce(noJobAttribution('1'));
    const res = await request(app)
      .get(`${BASE}/1/revenue`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('accepts a 20-digit call ID', async () => {
    const maxId = '1'.repeat(20);
    mockService.getCallRevenueAttribution.mockResolvedValueOnce(noJobAttribution(maxId));
    const res = await request(app)
      .get(`${BASE}/${maxId}/revenue`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

// ─── NO_LINKAGE response ───────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — NO_LINKAGE (call not in raw_st_calls)', () => {
  const noLinkageResult: CallRevenueAttribution = {
    callId: '9876543210',
    attributionStatus: 'NO_LINKAGE',
    attributionMethod: 'none',
    customerId: null,
    jobId: null,
    linkedInvoiceCount: 0,
    invoicedAmount: null,
    outstandingBalance: null,
    currency: null,
  };

  beforeEach(() => {
    mockService.getCallRevenueAttribution.mockResolvedValue(noLinkageResult);
  });

  it('returns status: success', async () => {
    const res = await authed();
    expect((res.body as { status: string }).status).toBe('success');
  });

  it('returns attributionStatus = NO_LINKAGE', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.attributionStatus).toBe('NO_LINKAGE');
    expect(data.attributionMethod).toBe('none');
  });

  it('returns null revenue fields', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.jobId).toBeNull();
    expect(data.customerId).toBeNull();
    expect(data.linkedInvoiceCount).toBe(0);
    expect(data.invoicedAmount).toBeNull();
    expect(data.outstandingBalance).toBeNull();
    expect(data.currency).toBeNull();
  });
});

// ─── NO_JOB response ──────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — NO_JOB (call exists, no job ID)', () => {
  beforeEach(() => {
    mockService.getCallRevenueAttribution.mockResolvedValue(noJobAttribution());
  });

  it('returns attributionStatus = NO_JOB', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.attributionStatus).toBe('NO_JOB');
    expect(data.attributionMethod).toBe('none');
  });

  it('returns customerId for context but no revenue figures', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.customerId).toBe('cust-42');
    expect(data.jobId).toBeNull();
    expect(data.invoicedAmount).toBeNull();
    expect(data.outstandingBalance).toBeNull();
    expect(data.currency).toBeNull();
  });
});

// ─── JOB_LINKED response ──────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — JOB_LINKED (call → job → invoices)', () => {
  beforeEach(() => {
    mockService.getCallRevenueAttribution.mockResolvedValue(jobLinkedAttribution());
  });

  it('returns attributionStatus = JOB_LINKED', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.attributionStatus).toBe('JOB_LINKED');
    expect(data.attributionMethod).toBe('call_job_invoice');
  });

  it('returns correct financial fields', async () => {
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.jobId).toBe('job-99');
    expect(data.customerId).toBe('cust-42');
    expect(data.linkedInvoiceCount).toBe(2);
    expect(data.invoicedAmount).toBe('1500.00');
    expect(data.outstandingBalance).toBe('350.00');
    expect(data.currency).toBe('USD');
  });

  it('passes the call ID (not a related ID) to the service', async () => {
    mockService.getCallRevenueAttribution.mockResolvedValue(jobLinkedAttribution('5555555555'));
    const res = await request(app)
      .get(`${BASE}/5555555555/revenue`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockService.getCallRevenueAttribution).toHaveBeenCalledWith('5555555555');
  });
});

// ─── JOB_LINKED — job with no invoices ───────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — JOB_LINKED, no invoices', () => {
  it('returns linkedInvoiceCount = 0 with null financial fields', async () => {
    const jobNoInvoices: CallRevenueAttribution = {
      callId: '9876543210',
      attributionStatus: 'JOB_LINKED',
      attributionMethod: 'call_job_invoice',
      customerId: 'cust-42',
      jobId: 'job-99',
      linkedInvoiceCount: 0,
      invoicedAmount: null,
      outstandingBalance: null,
      currency: null,
    };
    mockService.getCallRevenueAttribution.mockResolvedValue(jobNoInvoices);
    const res = await authed();
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.linkedInvoiceCount).toBe(0);
    expect(data.invoicedAmount).toBeNull();
    expect(data.currency).toBeNull();
  });
});

// ─── PII exclusion ────────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — PII exclusion', () => {
  it('does not expose phone numbers, recording URLs, or customer names', async () => {
    mockService.getCallRevenueAttribution.mockResolvedValue(jobLinkedAttribution());
    const res = await authed();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/phone/i);
    expect(raw).not.toMatch(/recordingUrl/i);
    expect(raw).not.toMatch(/voiceMailUrl/i);
    expect(raw).not.toMatch(/customerName/i);
    expect(raw).not.toMatch(/payload/i);
  });
});

// ─── DB failure ───────────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — DB failure', () => {
  it('propagates errors to the Express error handler (returns 5xx)', async () => {
    mockService.getCallRevenueAttribution.mockRejectedValueOnce(new Error('DB connection lost'));
    const res = await authed();
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ─── Response envelope ────────────────────────────────────────────────────────

describe('GET /telecom/calls/:callId/revenue — response shape', () => {
  it('wraps the attribution object in { status: "success", data: {...} }', async () => {
    mockService.getCallRevenueAttribution.mockResolvedValue(jobLinkedAttribution());
    const res = await authed();
    const body = res.body as { status: string; data: Record<string, unknown> };
    expect(body.status).toBe('success');
    expect(body.data).toHaveProperty('callId');
    expect(body.data).toHaveProperty('attributionStatus');
    expect(body.data).toHaveProperty('attributionMethod');
    expect(body.data).toHaveProperty('linkedInvoiceCount');
  });
});
