import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { qboAuthService } from '../../src/modules/quickbooks/auth.service';
import { qboApiClient } from '../../src/modules/quickbooks/api.client';
import { env } from '../../src/config/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = jest.fn() as any;

describe('QuickBooks Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    qboAuthService.clearCache();
  });

  describe('AuthService - Authorization URL', () => {
    it('should generate a valid OAuth 2.0 URL', () => {
      const url = qboAuthService.getAuthorizationUrl();
      expect(url).toContain(env.QBO_AUTH_URL);
      expect(url).toContain('client_id=' + env.QBO_CLIENT_ID);
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=' + encodeURIComponent('com.intuit.quickbooks.accounting'));
      expect(url).toContain('redirect_uri=' + encodeURIComponent(env.QBO_REDIRECT_URI));
      expect(url).toContain('state=');
    });
  });

  describe('AuthService - Token Exchange & Refresh', () => {
    it('should successfully exchange authorization code and cache tokens', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'qbo_access_token',
          refresh_token: 'qbo_refresh_token',
          expires_in: 3600,
          x_refresh_token_expires_in: 8640000
        })
      });

      await qboAuthService.exchangeCodeForToken('test_code', '12345');
      
      const tokens = await qboAuthService.getValidAccessToken();
      expect(tokens.accessToken).toBe('qbo_access_token');
      expect(tokens.realmId).toBe('12345');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should successfully refresh an expired token', async () => {
      // Simulate existing cache
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'qbo_access_token_old',
          refresh_token: 'qbo_refresh_token',
          expires_in: -100, // already expired
          x_refresh_token_expires_in: 8640000
        })
      });

      await qboAuthService.exchangeCodeForToken('test_code', '12345');
      
      // Mock the refresh response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'qbo_access_token_new',
          refresh_token: 'qbo_refresh_token_new',
          expires_in: 3600,
          x_refresh_token_expires_in: 8640000
        })
      });

      const tokens = await qboAuthService.getValidAccessToken();
      expect(tokens.accessToken).toBe('qbo_access_token_new');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should throw an error if not authenticated', async () => {
      await expect(qboAuthService.getValidAccessToken()).rejects.toThrow('QuickBooks is not authenticated. Please authorize first.');
    });
  });

  describe('ApiClient', () => {
    it('should attach Authorization and Accept headers', async () => {
      // Mock token setup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'qbo_access_token',
          refresh_token: 'qbo_refresh_token',
          expires_in: 3600,
          x_refresh_token_expires_in: 8640000
        })
      });
      await qboAuthService.exchangeCodeForToken('test_code', '12345');

      // Mock api fetch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: 'success' })
      });

      const res = await qboApiClient.get('/test');
      
      expect(res).toEqual({ data: 'success' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apiCallArgs = (global.fetch as any).mock.calls[1];
      expect(apiCallArgs[0]).toContain('/test');
      expect(apiCallArgs[1].headers).toEqual({
        'Authorization': 'Bearer qbo_access_token',
        'Accept': 'application/json',
      });
    });
  });
});
