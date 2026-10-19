// Mocked tests for the ServiceTitan V2 individual call details endpoint.
// No production DB writes, no live API calls, no scheduler execution.
//
// Response structure verified against live API 2026-10-09:
// { leadCall: { id, receivedOn, modifiedOn, duration, direction, callType, reason,
//               sid, agent{id,name,externalId}, createdBy{id,name}, campaign, customer,
//               tags, from[PII], to[PII], recordingUrl[PII], voiceMailUrl[PII] },
//   id: 0, jobNumber, projectId, businessUnit, type }

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-token', clearCache: () => undefined },
}));
jest.mock('../../src/modules/auth/auth.service', () => ({
  authService: { authenticate: async () => ({ userId: 'u1', sessionId: 'sess-1' }) },
}));

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import {
  TelecomCallDetailsService,
  CallDetailsUpstreamError,
  CallDetailsMalformedError,
  type V2CallDetails,
} from '../../src/modules/servicetitan/services/telecom-call-details.service';
import { ServiceTitanApiClient } from '../../src/modules/servicetitan/api.client';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';
import type { TelecomCallsRecordingService } from '../../src/modules/servicetitan/services/telecom-calls-recording.service';
import type { AuthService } from '../../src/modules/auth/auth.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CALL_ID = '93196845';

// Minimal raw bundle matching the verified live API shape.
function makeBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 0,              // always 0 — meaningless bundle surrogate
    jobNumber: 'J-00123',
    projectId: 0,
    businessUnit: null,
    type: null,
    leadCall: {
      id: 93196845,
      receivedOn: '2026-07-10T01:23:59.269Z',
      modifiedOn: '2026-07-10T01:35:16.130Z',
      duration: '00:02:51.2400000',
      direction: 'Outbound',
      callType: null,
      reason: null,
      from: '+15551234567',      // PII — must be stripped
      to: '+15559876543',        // PII — must be stripped
      recordingUrl: 'https://recordings.example.com/abc.mp3',  // PII
      voiceMailUrl: null,
      sid: '5792401072005120',
      agent: { id: 86377544, name: 'Jane Mapatac', externalId: null },
      createdBy: { id: 86377544, name: 'Jane Mapatac' },
      campaign: null,
      customer: {
        id: 7896929,
        name: 'Hardeep Gill',
        // PII fields that must never reach the client:
        email: 'hardeep@example.com',
        address: { street: '123 Main St', city: 'Surrey', state: 'BC', country: 'Canada', zip: 'V4N 4Y7' },
        contacts: [{ type: 'Phone', value: '6046499215' }],
        memberships: [{ id: 1, status: 'Active' }],
        phoneSettings: [{ phoneNumber: '6046499215', doNotText: false }],
        customFields: [],
      },
      tags: [],
    },
    ...overrides,
  };
}

// ─── TelecomCallDetailsService unit tests ────────────────────────────────────

describe('TelecomCallDetailsService', () => {
  let mockGet: jest.Mock;
  let svc: TelecomCallDetailsService;

  beforeEach(() => {
    mockGet = jest.fn();
    svc = new TelecomCallDetailsService({ get: mockGet } as unknown as ServiceTitanApiClient);
  });

  it('reads id from leadCall.id, not the bundle id=0', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.id).toBe(93196845);   // leadCall.id
    expect(result.id).not.toBe(0);      // NOT the bundle surrogate
  });

  it('maps all expected leadCall fields', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.receivedOn).toBe('2026-07-10T01:23:59.269Z');
    expect(result.modifiedOn).toBe('2026-07-10T01:35:16.130Z');
    expect(result.duration).toBe('00:02:51.2400000');
    expect(result.direction).toBe('Outbound');
    expect(result.callType).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.sid).toBe('5792401072005120');
    expect(result.tags).toEqual([]);
  });

  it('maps callType (not status)', async () => {
    mockGet.mockImplementation(async () => makeBundle({
      leadCall: { ...makeBundle()['leadCall'] as object, callType: 'Lead' },
    }) as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.callType).toBe('Lead');
    // 'status' is not a field on V2CallDetails — the type system enforces this.
  });

  it('maps agent with externalId field', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.agent).toEqual({ id: 86377544, name: 'Jane Mapatac', externalId: null });
  });

  it('maps createdBy', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.createdBy).toEqual({ id: 86377544, name: 'Jane Mapatac' });
  });

  it('maps bundle-level context fields', async () => {
    mockGet.mockImplementation(async () => makeBundle({
      jobNumber: 'J-99999',
      projectId: 12345,
      businessUnit: { id: 7, name: 'HVAC' },
      type: 'Service',
    }) as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.jobNumber).toBe('J-99999');
    expect(result.projectId).toBe(12345);
    expect(result.businessUnit).toEqual({ id: 7, name: 'HVAC' });
    expect(result.type).toBe('Service');
  });

  it('returns only id+name for customer — strips all PII', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.customer).toEqual({ id: 7896929, name: 'Hardeep Gill' });
    // PII fields must not appear
    const c = result.customer as unknown as Record<string, unknown>;
    expect(c['email']).toBeUndefined();
    expect(c['address']).toBeUndefined();
    expect(c['contacts']).toBeUndefined();
    expect(c['memberships']).toBeUndefined();
    expect(c['phoneSettings']).toBeUndefined();
    expect(c['customFields']).toBeUndefined();
  });

  it('strips call-level sensitive fields', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    const r = result as unknown as Record<string, unknown>;
    expect(r['from']).toBeUndefined();
    expect(r['to']).toBeUndefined();
    expect(r['recordingUrl']).toBeUndefined();
    expect(r['voiceMailUrl']).toBeUndefined();
  });

  it('does not expose removed/inferred fields (active, location, businessUnitId, createdOn, status)', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    const r = result as unknown as Record<string, unknown>;
    expect(r['active']).toBeUndefined();
    expect(r['location']).toBeUndefined();
    expect(r['businessUnitId']).toBeUndefined();
    expect(r['createdOn']).toBeUndefined();
    // 'status' was never a real field — it does not exist on V2CallDetails type
    // and the service never sets it, so checking the type is sufficient.
  });

  it('handles null customer gracefully', async () => {
    const bundle = makeBundle();
    (bundle['leadCall'] as Record<string, unknown>)['customer'] = null;
    mockGet.mockImplementation(async () => bundle as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.customer).toBeNull();
  });

  it('handles null/missing optional leadCall fields gracefully', async () => {
    const bundle = makeBundle();
    const lc = bundle['leadCall'] as Record<string, unknown>;
    lc['agent'] = null;
    lc['createdBy'] = null;
    lc['campaign'] = null;
    lc['reason'] = null;
    lc['sid'] = null;
    lc['duration'] = null;
    lc['receivedOn'] = null;
    lc['tags'] = undefined;
    mockGet.mockImplementation(async () => bundle as unknown);
    const result = await svc.getCallDetails(CALL_ID);
    expect(result.agent).toBeNull();
    expect(result.createdBy).toBeNull();
    expect(result.campaign).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.sid).toBeNull();
    expect(result.duration).toBeNull();
    expect(result.receivedOn).toBeNull();
    expect(result.tags).toEqual([]);
  });

  it('throws CallDetailsMalformedError when leadCall is missing', async () => {
    mockGet.mockImplementation(async () => ({ id: 0, jobNumber: null, projectId: 0, businessUnit: null, type: null }) as unknown);
    await expect(svc.getCallDetails(CALL_ID)).rejects.toThrow(CallDetailsMalformedError);
    await expect(svc.getCallDetails(CALL_ID)).rejects.toThrow(/missing leadCall/);
  });

  it('throws CallDetailsMalformedError when leadCall is null', async () => {
    mockGet.mockImplementation(async () => ({ ...makeBundle(), leadCall: null }) as unknown);
    await expect(svc.getCallDetails(CALL_ID)).rejects.toThrow(CallDetailsMalformedError);
  });

  it('calls the correct V2 tenant endpoint path', async () => {
    mockGet.mockImplementation(async () => makeBundle() as unknown);
    await svc.getCallDetails(CALL_ID);
    const endpoint = mockGet.mock.calls[0]![0] as string;
    expect(endpoint).toMatch(/^\/telecom\/v2\/tenant\/\d+\/calls\/93196845$/);
  });

  it('throws CallDetailsUpstreamError(404) on ST 404', async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error('ServiceTitan API Error: [404]')));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ name: 'CallDetailsUpstreamError', statusCode: 404 });
  });

  it('throws CallDetailsUpstreamError(502) on ST 401', async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error('ServiceTitan API Error: [401]')));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws CallDetailsUpstreamError(502) on ST 403', async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error('ServiceTitan API Error: [403]')));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws CallDetailsUpstreamError(429) on ST 429', async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error('ServiceTitan API Error: [429]')));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('throws CallDetailsUpstreamError(502) on ST 500', async () => {
    mockGet.mockImplementation(() => Promise.reject(new Error('ServiceTitan API Error: [500]')));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws CallDetailsUpstreamError(504) on AbortError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockGet.mockImplementation(() => Promise.reject(abort));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toMatchObject({ statusCode: 504 });
  });

  it('re-throws unknown errors without wrapping', async () => {
    const err = new TypeError('network glitch');
    mockGet.mockImplementation(() => Promise.reject(err));
    await expect(svc.getCallDetails(CALL_ID)).rejects.toBe(err);
  });
});

// ─── HTTP route integration tests ────────────────────────────────────────────

function buildApp(callDetailsService: TelecomCallDetailsService) {
  const app = express();
  app.use(express.json());

  const mockAuthService = {
    authenticate: async () => ({ userId: 'u1', sessionId: 'sess-1' }),
  } as unknown as AuthService;

  const mockRecordingService = {
    checkEligibility: jest.fn(),
    fetchStream: jest.fn(),
  } as unknown as TelecomCallsRecordingService;

  const router = createServiceTitanReportingRouter(mockRecordingService, mockAuthService, callDetailsService);
  app.use('/api/reporting/servicetitan', router);
  return app;
}

describe('GET /api/reporting/servicetitan/telecom/calls/:callId — HTTP', () => {
  let callDetailsService: jest.Mocked<TelecomCallDetailsService>;
  let app: ReturnType<typeof express>;

  const mockDetails: V2CallDetails = {
    id: 93196845,
    receivedOn: '2026-07-10T01:23:59.269Z',
    modifiedOn: '2026-07-10T01:35:16.130Z',
    duration: '00:02:51.2400000',
    direction: 'Outbound',
    callType: null,
    reason: null,
    sid: '5792401072005120',
    agent: { id: 86377544, name: 'Jane Mapatac', externalId: null },
    createdBy: { id: 86377544, name: 'Jane Mapatac' },
    campaign: null,
    customer: { id: 7896929, name: 'Hardeep Gill' },
    tags: [],
    jobNumber: 'J-00123',
    projectId: 0,
    businessUnit: null,
    type: null,
  };

  beforeEach(() => {
    callDetailsService = { getCallDetails: jest.fn() } as unknown as jest.Mocked<TelecomCallDetailsService>;
    app = buildApp(callDetailsService);
  });

  it('returns 200 with correctly mapped call details', async () => {
    callDetailsService.getCallDetails.mockResolvedValue(mockDetails);
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.id).toBe(93196845);
    expect(res.body.data.id).not.toBe(0);
    expect(res.body.data.direction).toBe('Outbound');
    expect(res.body.data.callType).toBeNull();
    expect(res.body.data.agent).toEqual({ id: 86377544, name: 'Jane Mapatac', externalId: null });
    expect(res.body.data.createdBy).toEqual({ id: 86377544, name: 'Jane Mapatac' });
    expect(res.body.data.customer).toEqual({ id: 7896929, name: 'Hardeep Gill' });
  });

  it('passes the correct callId to the service', async () => {
    callDetailsService.getCallDetails.mockResolvedValue(mockDetails);
    await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token2');
    expect(callDetailsService.getCallDetails).toHaveBeenCalledWith(CALL_ID);
  });

  it('returns 400 for a non-numeric call ID', async () => {
    const res = await request(app)
      .get('/api/reporting/servicetitan/telecom/calls/abc')
      .set('Authorization', 'Bearer valid-session-token3');
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });

  it('returns 400 for an oversized call ID (> 20 digits)', async () => {
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${'1'.repeat(21)}`)
      .set('Authorization', 'Bearer valid-session-token4');
    expect(res.status).toBe(400);
  });

  it('returns 404 when call is not found', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new CallDetailsUpstreamError(404, 'Call not found.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token5');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Call not found.');
  });

  it('returns 502 on ServiceTitan auth failure', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new CallDetailsUpstreamError(502, 'ServiceTitan authentication failed.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token6');
    expect(res.status).toBe(502);
  });

  it('returns 429 on upstream rate limit', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new CallDetailsUpstreamError(429, 'ServiceTitan rate limit exceeded. Please retry shortly.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token7');
    expect(res.status).toBe(429);
  });

  it('returns 504 on upstream timeout', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new CallDetailsUpstreamError(504, 'ServiceTitan request timed out.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token8');
    expect(res.status).toBe(504);
  });

  it('returns 502 on upstream 5xx', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new CallDetailsUpstreamError(502, 'ServiceTitan service temporarily unavailable.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-token9');
    expect(res.status).toBe(502);
  });

  it('passes unexpected errors to Express error handler (500)', async () => {
    callDetailsService.getCallDetails.mockRejectedValue(new TypeError('unexpected'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-tokenA');
    expect(res.status).toBe(500);
  });

  it('does not expose sensitive fields in the HTTP response', async () => {
    callDetailsService.getCallDetails.mockResolvedValue(mockDetails);
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', 'Bearer valid-session-tokenB');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('from');
    expect(res.body.data).not.toHaveProperty('to');
    expect(res.body.data).not.toHaveProperty('recordingUrl');
    expect(res.body.data).not.toHaveProperty('voiceMailUrl');
    expect(res.body.data).not.toHaveProperty('active');
    expect(res.body.data).not.toHaveProperty('status');
    expect(res.body.data).not.toHaveProperty('location');
    expect(res.body.data).not.toHaveProperty('businessUnitId');
    expect(res.body.data).not.toHaveProperty('createdOn');
  });

  it('recording route is not intercepted by call-details route (no regression)', async () => {
    callDetailsService.getCallDetails.mockResolvedValue(mockDetails);
    await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/recording`)
      .set('Authorization', 'Bearer valid-session-tokenC');
    expect(callDetailsService.getCallDetails).not.toHaveBeenCalled();
  });
});
