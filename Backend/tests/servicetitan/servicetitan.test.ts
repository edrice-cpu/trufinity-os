import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { authService } from '../../src/modules/servicetitan/auth.service';
import { apiClient } from '../../src/modules/servicetitan/api.client';
import { customerService } from '../../src/modules/servicetitan/services/customer.service';
import { env } from '../../src/config/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = jest.fn() as any;

describe('ServiceTitan Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authService.clearCache();
  });

  describe('AuthService', () => {
    it('should successfully acquire and cache a token', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'mock_token',
          expires_in: 3600,
          token_type: 'Bearer'
        })
      });

      const token = await authService.getAccessToken();
      expect(token).toBe('mock_token');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const cachedToken = await authService.getAccessToken();
      expect(cachedToken).toBe('mock_token');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should throw an error on authentication failure', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      });

      await expect(authService.getAccessToken()).rejects.toThrow('Failed to fetch ServiceTitan token: 401');
    });
  });

  describe('ApiClient', () => {
    it('should attach Authorization and ST-App-Key headers', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'mock_token', expires_in: 3600, token_type: 'Bearer' })
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: 'success' })
      });

      const res = await apiClient.get('/test', { page: 1 });
      
      expect(res).toEqual({ data: 'success' });
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apiCallArgs = (global.fetch as any).mock.calls[1];
      expect(apiCallArgs[0]).toContain('/test?page=1');
      expect(apiCallArgs[1].headers).toEqual({
        'Authorization': 'Bearer mock_token',
        'ST-App-Key': env.SERVICETITAN_APP_KEY,
        'Accept': 'application/json',
      });
    });
  });

  describe('CustomerService', () => {
    it('should fetch paginated customers', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'mock_token', expires_in: 3600 })
      });

      const mockResponse = {
        page: 1,
        pageSize: 50,
        hasMore: false,
        data: [{ id: 1, name: 'John Doe', active: true }]
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const response = await customerService.getCustomers(1, 50);
      expect(response.data.length).toBe(1);
      expect(response.data[0].name).toBe('John Doe');
    });
  });
});
