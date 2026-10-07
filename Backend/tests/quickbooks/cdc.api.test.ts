import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QboApiClient, QboApiError } from '../../src/modules/quickbooks/api.client';
import { qboAuthService } from '../../src/modules/quickbooks/auth.service';

describe('QBO CDC API client', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('constructs the official CDC path and query for multiple entities', async () => {
    jest.spyOn(qboAuthService, 'getValidAccessToken').mockResolvedValue({ accessToken: 'test-access-token', realmId: 'realm/123' });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ CDCResponse: [], time: '2026-09-16T12:00:00Z' }),
    } as Response);
    const since = '2026-09-16T11:58:00.000Z';
    await new QboApiClient().getCdc(['Customer', 'Invoice'], since);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/v3/company/realm%2F123/cdc');
    expect(url.searchParams.get('entities')).toBe('Customer,Invoice');
    expect(url.searchParams.get('changedSince')).toBe(since);
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ Accept: 'application/json' });
  });

  it('does not clear durable OAuth tokens after a CDC 401 response', async () => {
    jest.spyOn(qboAuthService, 'getValidAccessToken').mockResolvedValue({ accessToken: 'test-access-token', realmId: 'realm-1' });
    jest.spyOn(qboAuthService, 'refreshAccessToken').mockRejectedValue(new Error('mocked refresh failure'));
    const clear = jest.spyOn(qboAuthService, 'clearCache');
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, text: async () => 'sensitive provider body' } as Response);
    await expect(new QboApiClient().getCdc(['Customer'], '2026-09-16T11:58:00Z')).rejects.toBeInstanceOf(QboApiError);
    expect(clear).not.toHaveBeenCalled();
  });

  it('rejects unsupported or invalid CDC request input before making a request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(new QboApiClient().getCdc([], '2026-09-16T11:58:00Z')).rejects.toThrow();
    await expect(new QboApiClient().getCdc(['Customer'], 'not-a-date')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
