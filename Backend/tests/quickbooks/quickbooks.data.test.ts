import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { qboAuthService } from '../../src/modules/quickbooks/auth.service';
import { qboCompanyInfoService } from '../../src/modules/quickbooks/services/companyinfo.service';
import { qboCustomerService } from '../../src/modules/quickbooks/services/customer.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = jest.fn() as any;

describe('QuickBooks Data Services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    qboAuthService.clearCache();
  });

  describe('CustomerService', () => {
    it('should fetch customers using SQL query format', async () => {
      // Mock auth
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'mock_token', refresh_token: 'mock', expires_in: 3600, x_refresh_token_expires_in: 864000 })
      });
      await qboAuthService.exchangeCodeForToken('code', '999');

      // Mock QBO Query API response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          QueryResponse: {
            Customer: [{ Id: '1', DisplayName: 'Test Customer' }]
          },
          time: 'now'
        })
      });

      const customers = await qboCustomerService.getCustomers(5);
      
      expect(customers.length).toBe(1);
      expect(customers[0].DisplayName).toBe('Test Customer');
      
      // Verify query params were passed properly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apiCallArgs = (global.fetch as any).mock.calls[1];
      expect(apiCallArgs[0]).toContain('query=select+*+from+Customer+maxresults+5');
    });
  });

  describe('CompanyInfoService', () => {
    it('should fetch company info using REST format', async () => {
      // Mock auth
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'mock_token', refresh_token: 'mock', expires_in: 3600, x_refresh_token_expires_in: 864000 })
      });
      await qboAuthService.exchangeCodeForToken('code', '999');

      // Mock CompanyInfo REST API response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          CompanyInfo: { Id: '999', CompanyName: 'Test Company' }
        })
      });

      const companyInfo = await qboCompanyInfoService.getCompanyInfo();
      
      expect(companyInfo.CompanyName).toBe('Test Company');
      
      // Verify URL pattern
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apiCallArgs = (global.fetch as any).mock.calls[1];
      expect(apiCallArgs[0]).toContain('/v3/company/999/companyinfo/999');
    });
  });
});
