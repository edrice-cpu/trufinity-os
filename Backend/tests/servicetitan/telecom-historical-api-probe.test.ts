import { describe, expect, it } from '@jest/globals';
import { runHistoricalApiProbe } from '../../src/scripts/st_telecom_historical_api_probe';
import type { TelecomCallsExportApi, TelecomCallsExportResponse } from '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion';

// ---------------------------------------------------------------------------
// Fake API client — no real HTTP calls, no DB interaction
// ---------------------------------------------------------------------------

class FakeApiClient implements TelecomCallsExportApi {
  public readonly calls: Array<{ endpoint: string; params: Record<string, unknown> | undefined }> = [];
  private readonly response: TelecomCallsExportResponse | Error;

  constructor(response: TelecomCallsExportResponse | Error) {
    this.response = response;
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ endpoint, params });
    if (this.response instanceof Error) throw this.response;
    return this.response as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHistoricalApiProbe — success path', () => {
  it('makes exactly one API request with the correct from parameter', async () => {
    const client = new FakeApiClient({
      hasMore: true,
      continueFrom: 'some-cursor',
      data: Array(159).fill({ id: 1 }),
    });
    await runHistoricalApiProbe(client, '2026-07-10');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.params).toEqual({ from: '2026-07-10' });
  });

  it('returns success:true with correct recordCount', async () => {
    const client = new FakeApiClient({
      hasMore: false,
      continueFrom: 'tok-end',
      data: Array(250).fill({ id: 1 }),
    });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.success).toBe(true);
    expect(result.recordCount).toBe(250);
  });

  it('reports hasMore correctly when true', async () => {
    const client = new FakeApiClient({ hasMore: true, continueFrom: 'tok', data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.hasMore).toBe(true);
  });

  it('reports hasMore correctly when false', async () => {
    const client = new FakeApiClient({ hasMore: false, data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.hasMore).toBe(false);
  });

  it('reports hasContinueFrom:true when continueFrom is present', async () => {
    const client = new FakeApiClient({ hasMore: true, continueFrom: 'cursor-val', data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.hasContinueFrom).toBe(true);
  });

  it('reports hasContinueFrom:false when continueFrom is absent', async () => {
    const client = new FakeApiClient({ hasMore: false, data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.hasContinueFrom).toBe(false);
  });

  it('reports hasContinueFrom:false when continueFrom is an empty string', async () => {
    const client = new FakeApiClient({ hasMore: false, continueFrom: '   ', data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.hasContinueFrom).toBe(false);
  });

  it('returns null error fields on success', async () => {
    const client = new FakeApiClient({ hasMore: false, data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.errorName).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.errorCauseCode).toBeNull();
    expect(result.httpStatus).toBeNull();
  });

  it('durationMs is a non-negative integer', async () => {
    const client = new FakeApiClient({ hasMore: false, data: [] });
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it('does not make a second request even when hasMore is true', async () => {
    const client = new FakeApiClient({ hasMore: true, continueFrom: 'more', data: [{ id: 1 }] });
    await runHistoricalApiProbe(client, '2026-07-10');
    // Exactly one call — probe must NOT follow pagination
    expect(client.calls).toHaveLength(1);
  });
});

describe('runHistoricalApiProbe — failure path', () => {
  it('returns success:false on HTTP 503', async () => {
    const client = new FakeApiClient(new Error('ServiceTitan API Error: [503]'));
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.success).toBe(false);
  });

  it('extracts httpStatus from HTTP error message', async () => {
    const client = new FakeApiClient(new Error('ServiceTitan API Error: [403]'));
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.httpStatus).toBe(403);
  });

  it('reports null httpStatus for a network error (no HTTP response)', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const client = new FakeApiClient(err);
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.httpStatus).toBeNull();
  });

  it('captures errorName for a TypeError (network failure)', async () => {
    const err = new TypeError('fetch failed');
    const client = new FakeApiClient(err);
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.errorName).toBe('TypeError');
  });

  it('captures errorCode from the error directly', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const client = new FakeApiClient(err);
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.errorCode).toBe('ECONNRESET');
  });

  it('captures errorCauseCode from error.cause', async () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    const client = new FakeApiClient(err);
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.errorCauseCode).toBe('ETIMEDOUT');
  });

  it('captures AbortError name (timeout)', async () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const client = new FakeApiClient(err);
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.errorName).toBe('AbortError');
    expect(result.httpStatus).toBeNull();
  });

  it('returns null record fields on failure', async () => {
    const client = new FakeApiClient(new Error('ServiceTitan API Error: [503]'));
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.recordCount).toBeNull();
    expect(result.hasMore).toBeNull();
    expect(result.hasContinueFrom).toBeNull();
  });

  it('does not throw — always returns a result object', async () => {
    const client = new FakeApiClient(new Error('unexpected'));
    const result = await runHistoricalApiProbe(client, '2026-07-10');
    expect(result.success).toBe(false);
  });
});

describe('runHistoricalApiProbe — single-call invariant', () => {
  it('uses the provided from date, not a hardcoded default', async () => {
    const client = new FakeApiClient({ hasMore: false, data: [] });
    await runHistoricalApiProbe(client, '2026-08-01');
    expect(client.calls[0]!.params).toEqual({ from: '2026-08-01' });
  });
});
