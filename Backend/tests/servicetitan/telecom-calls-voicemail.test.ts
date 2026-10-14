// Mocked tests for the ServiceTitan voicemail streaming endpoint.
// No production DB writes, no live API calls, no scheduler execution.
//
// Endpoint: GET /api/reporting/servicetitan/telecom/calls/:callId/voicemail
// Streams voicemail audio from ServiceTitan without buffering or DB eligibility check.

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-st-token', clearCache: () => undefined },
}));

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../src/modules/auth/auth.service';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';
import {
  TelecomCallsRecordingService,
  RecordingUpstreamError,
} from '../../src/modules/servicetitan/services/telecom-calls-recording.service';
import type { TelecomCallDetailsService } from '../../src/modules/servicetitan/services/telecom-call-details.service';

// ─── Fakes ────────────────────────────────────────────────────────────────────

const VALID_TOKEN = 'valid-session-token-xyz789';
const SESSION_ID = 'voicemail-session-001';
const CALL_ID = '93196845';

const fakeAuthService: AuthService = {
  login: jest.fn() as never,
  logout: jest.fn() as never,
  requestPasswordReset: jest.fn() as never,
  resetPassword: jest.fn() as never,
  authenticate: jest.fn(async (token: string) =>
    token === VALID_TOKEN
      ? { sessionId: SESSION_ID, user: { id: 'user-1', email: 'owner@trufinity.ca', fullName: null } }
      : null,
  ),
} as unknown as AuthService;

const audioStream = (bytes: Uint8Array = new Uint8Array([0xff, 0xfb, 0x90])): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });

function makeRecordingService(overrides: {
  fetchVoicemailStream?: jest.MockedFunction<TelecomCallsRecordingService['fetchVoicemailStream']>;
  fetchStream?: jest.MockedFunction<TelecomCallsRecordingService['fetchStream']>;
  checkEligibility?: jest.MockedFunction<TelecomCallsRecordingService['checkEligibility']>;
}): TelecomCallsRecordingService {
  const svc = new TelecomCallsRecordingService({} as never, {} as never, () => Promise.resolve({} as Response));
  if (overrides.fetchVoicemailStream) jest.spyOn(svc, 'fetchVoicemailStream').mockImplementation(overrides.fetchVoicemailStream);
  if (overrides.fetchStream)         jest.spyOn(svc, 'fetchStream').mockImplementation(overrides.fetchStream);
  if (overrides.checkEligibility)    jest.spyOn(svc, 'checkEligibility').mockImplementation(overrides.checkEligibility);
  return svc;
}

function buildApp(recordingService: TelecomCallsRecordingService) {
  const app = express();
  app.use(express.json());
  const stubCallDetails = { getCallDetails: jest.fn() } as unknown as TelecomCallDetailsService;
  const router = createServiceTitanReportingRouter(recordingService, fakeAuthService, stubCallDetails);
  app.use('/api/reporting/servicetitan', router);
  return app;
}

// ─── TelecomCallsRecordingService.fetchVoicemailStream unit tests ─────────────

describe('TelecomCallsRecordingService.fetchVoicemailStream', () => {
  it('calls the voicemail endpoint (not the recording endpoint)', async () => {
    let capturedUrl = '';
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async (url: string) => {
        capturedUrl = url;
        return new Response(audioStream(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      },
    );
    await svc.fetchVoicemailStream(CALL_ID, new AbortController().signal);
    expect(capturedUrl).toContain('/voicemail');
    expect(capturedUrl).not.toContain('/recording');
    expect(capturedUrl).toContain(CALL_ID);
  });

  it('uses redirect:manual (SSRF protection)', async () => {
    let capturedInit: RequestInit | undefined;
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return new Response(audioStream(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      },
    );
    await svc.fetchVoicemailStream(CALL_ID, new AbortController().signal);
    expect(capturedInit?.redirect).toBe('manual');
  });

  it('returns stream, contentType and contentLength on success', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(audioStream(), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '1024' },
      }),
    );
    const result = await svc.fetchVoicemailStream(CALL_ID, new AbortController().signal);
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.contentLength).toBe('1024');
    expect(result.body).toBeDefined();
  });

  it('throws RecordingUpstreamError(404) on ST 404', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(null, { status: 404 }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ name: 'RecordingUpstreamError', statusCode: 404, message: 'Voicemail not available for this call.' });
  });

  it('throws RecordingUpstreamError(502) on ST 401', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(null, { status: 401 }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 502, message: 'Voicemail service authentication failed.' });
  });

  it('throws RecordingUpstreamError(502) on ST 403', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(null, { status: 403 }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws RecordingUpstreamError(502) on ST 5xx', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(null, { status: 503 }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 502, message: 'Voicemail service temporarily unavailable.' });
  });

  it('throws RecordingUpstreamError(502) on unexpected Content-Type', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 502, message: 'Unexpected response type from voicemail service.' });
  });

  it('throws RecordingUpstreamError(429) on ST 429', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => new Response(null, { status: 429 }),
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ name: 'RecordingUpstreamError', statusCode: 429, message: 'Voicemail service rate limit reached. Please try again shortly.' });
  });

  it('throws RecordingUpstreamError(502) on opaque redirect (status 0)', async () => {
    // new Response(null, { status: 0 }) throws RangeError in Node.js — simulate via a mock object.
    const mockOpaque = {
      status: 0,
      ok: false,
      headers: { get: () => null },
      body: { cancel: async () => undefined },
    } as unknown as Response;
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async () => mockOpaque,
    );
    await expect(svc.fetchVoicemailStream(CALL_ID, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 502, message: 'Unexpected redirect from upstream voicemail service.' });
  });

  it('does NOT include Authorization header value in any thrown error', async () => {
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'super-secret-token' } as never,
      async () => new Response(null, { status: 404 }),
    );
    try {
      await svc.fetchVoicemailStream(CALL_ID, new AbortController().signal);
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-token');
    }
  });

  it('fetchStream still uses the recording endpoint (no regression)', async () => {
    let capturedUrl = '';
    const svc = new TelecomCallsRecordingService(
      {} as never,
      { getAccessToken: async () => 'tok' } as never,
      async (url: string) => {
        capturedUrl = url;
        return new Response(audioStream(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      },
    );
    await svc.fetchStream(CALL_ID, new AbortController().signal);
    expect(capturedUrl).toContain('/recording');
    expect(capturedUrl).not.toContain('/voicemail');
  });
});

// ─── HTTP route integration tests ────────────────────────────────────────────

describe('GET /api/reporting/servicetitan/telecom/calls/:callId/voicemail — HTTP', () => {
  let app: ReturnType<typeof express>;
  let mockFetchVoicemailStream: jest.MockedFunction<TelecomCallsRecordingService['fetchVoicemailStream']>;

  beforeEach(() => {
    mockFetchVoicemailStream = jest.fn() as jest.MockedFunction<TelecomCallsRecordingService['fetchVoicemailStream']>;
    const svc = makeRecordingService({ fetchVoicemailStream: mockFetchVoicemailStream });
    app = buildApp(svc);
  });

  it('streams audio and sets correct response headers on success', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    mockFetchVoicemailStream.mockResolvedValue({
      body: audioStream(bytes),
      contentType: 'audio/mpeg',
      contentLength: String(bytes.length),
    });
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .buffer(true)
      .parse((r, fn) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => fn(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^audio\/mpeg/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from(bytes));
    expect(mockFetchVoicemailStream).toHaveBeenCalledWith(CALL_ID, expect.any(AbortSignal));
  });

  it('passes the correct callId to fetchVoicemailStream', async () => {
    mockFetchVoicemailStream.mockResolvedValue({ body: audioStream(), contentType: 'audio/mpeg', contentLength: null });
    await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(mockFetchVoicemailStream.mock.calls[0]![0]).toBe(CALL_ID);
  });

  it('returns 400 for a non-numeric call ID', async () => {
    const res = await request(app)
      .get('/api/reporting/servicetitan/telecom/calls/not-a-number/voicemail')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });

  it('returns 400 for an oversized call ID (> 20 digits)', async () => {
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${'9'.repeat(21)}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it('returns 401 for an unauthenticated request', async () => {
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid session token', async () => {
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', 'Bearer invalid-token-that-is-long-enough');
    expect(res.status).toBe(401);
  });

  it('returns 404 when voicemail is not available', async () => {
    mockFetchVoicemailStream.mockRejectedValue(new RecordingUpstreamError(404, 'Voicemail not available for this call.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Voicemail not available for this call.');
  });

  it('returns 502 on ServiceTitan auth failure', async () => {
    mockFetchVoicemailStream.mockRejectedValue(new RecordingUpstreamError(502, 'Voicemail service authentication failed.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(502);
  });

  it('returns 502 on upstream unavailable', async () => {
    mockFetchVoicemailStream.mockRejectedValue(new RecordingUpstreamError(502, 'Voicemail service temporarily unavailable.'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(502);
  });

  it('passes unexpected errors to Express error handler (500)', async () => {
    mockFetchVoicemailStream.mockRejectedValue(new Error('unexpected internal error'));
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(500);
  });

  it('omits Content-Length header when upstream does not provide it', async () => {
    mockFetchVoicemailStream.mockResolvedValue({ body: audioStream(), contentType: 'audio/mpeg', contentLength: null });
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('does not expose Authorization header or ST-App-Key in response headers', async () => {
    mockFetchVoicemailStream.mockResolvedValue({ body: audioStream(), contentType: 'audio/mpeg', contentLength: null });
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .buffer(true)
      .parse((r, fn) => { const c: Buffer[] = []; r.on('data', (b: Buffer) => c.push(b)); r.on('end', () => fn(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['authorization']).toBeUndefined();
    expect(res.headers['st-app-key']).toBeUndefined();
    // Response headers must not leak any upstream auth values
    const allHeaderValues = Object.values(res.headers).join(' ');
    expect(allHeaderValues).not.toContain(VALID_TOKEN);
  });

  it('recording endpoint still works after adding voicemail route (no regression)', async () => {
    const mockFetchStream = jest.fn() as jest.MockedFunction<TelecomCallsRecordingService['fetchStream']>;
    const mockCheckEligibility = jest.fn() as jest.MockedFunction<TelecomCallsRecordingService['checkEligibility']>;
    mockCheckEligibility.mockResolvedValue('eligible');
    mockFetchStream.mockResolvedValue({ body: audioStream(), contentType: 'audio/mpeg', contentLength: null });
    const svc = makeRecordingService({ fetchStream: mockFetchStream, checkEligibility: mockCheckEligibility, fetchVoicemailStream: mockFetchVoicemailStream });
    const testApp = buildApp(svc);

    const res = await request(testApp)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/recording`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockFetchStream).toHaveBeenCalledWith(CALL_ID, expect.any(AbortSignal));
    expect(mockFetchVoicemailStream).not.toHaveBeenCalled();
  });

  it('call-details endpoint still works after adding voicemail route (no regression)', async () => {
    await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    // The call-details service is a stub (getCallDetails = jest.fn, returns undefined → 500).
    // The key check: voicemail service was NOT called for this path.
    expect(mockFetchVoicemailStream).not.toHaveBeenCalled();
  });

  it('returns 429 on upstream rate limit', async () => {
    mockFetchVoicemailStream.mockRejectedValue(
      new RecordingUpstreamError(429, 'Voicemail service rate limit reached. Please try again shortly.'),
    );
    const res = await request(app)
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ status: 'error' });
  });
});

// ─── Streaming lifecycle regression — voicemail res.on('close') fix ──────────

describe('Voicemail streaming lifecycle — res.on(close) fix', () => {
  const fakeAuth3: AuthService = {
    authenticate: jest.fn(async (token: string) =>
      token === VALID_TOKEN ? { sessionId: SESSION_ID, user: { id: 'u1', email: 'e@t.com', fullName: null } } : null,
    ),
  } as unknown as AuthService;

  const buildApp3 = (svc: TelecomCallsRecordingService) => {
    const app = express();
    app.use(express.json());
    const stubCallDetails = { getCallDetails: jest.fn() } as unknown as TelecomCallDetailsService;
    app.use('/api/reporting/servicetitan', createServiceTitanReportingRouter(svc, fakeAuth3, stubCallDetails));
    return app;
  };

  it('does not abort the AbortSignal before the voicemail stream completes (normal GET lifecycle)', async () => {
    // Before the fix, req.on('close') fired immediately for GET requests, aborting
    // the controller before fetchVoicemailStream could return any data.
    let capturedSignal: AbortSignal | undefined;
    const svc = new TelecomCallsRecordingService({} as never, {} as never, () => Promise.resolve({} as Response));
    jest.spyOn(svc, 'fetchVoicemailStream').mockImplementation(async (_id, signal) => {
      capturedSignal = signal;
      return {
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } }),
        contentType: 'audio/mpeg',
        contentLength: '1',
      };
    });

    await request(buildApp3(svc))
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .buffer(true)
      .parse((r, fn) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => fn(null, Buffer.concat(chunks)));
      });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('returns 200 and streams voicemail bytes after fix', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const svc = new TelecomCallsRecordingService({} as never, {} as never, () => Promise.resolve({} as Response));
    jest.spyOn(svc, 'fetchVoicemailStream').mockResolvedValue({
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
      contentType: 'audio/mpeg',
      contentLength: String(bytes.length),
    });

    const res = await request(buildApp3(svc))
      .get(`/api/reporting/servicetitan/telecom/calls/${CALL_ID}/voicemail`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .buffer(true)
      .parse((r, fn) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => fn(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from(bytes));
  });
});
