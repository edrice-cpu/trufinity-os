import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../../src/modules/quickbooks/auth.service', () => ({
  qboAuthService: { getValidAccessToken: jest.fn() },
}));
jest.mock('../../src/modules/quickbooks/api.client', () => ({
  qboApiClient: { get: jest.fn() },
}));

import { qboApiClient } from '../../src/modules/quickbooks/api.client';
import { qboAuthService } from '../../src/modules/quickbooks/auth.service';
import { QboCustomerService } from '../../src/modules/quickbooks/services/customer.service';

describe('QuickBooks Customer historical query', () => {
  it('includes active and inactive customers and preserves startposition/maxresults pagination', async () => {
    jest.mocked(qboAuthService.getValidAccessToken).mockResolvedValue({
      accessToken: 'test-token',
      realmId: 'test-realm',
    });
    jest.mocked(qboApiClient.get).mockResolvedValue({ QueryResponse: { Customer: [] }, time: 'test-time' });

    const service = new QboCustomerService();
    await service.getCustomersPage(1, 1000);
    await service.getCustomersPage(1001, 1000);

    expect(qboApiClient.get).toHaveBeenNthCalledWith(
      1,
      '/v3/company/test-realm/query',
      { query: 'select * from Customer where Active in (true,false) maxresults 1000 startposition 1' },
    );
    expect(qboApiClient.get).toHaveBeenNthCalledWith(
      2,
      '/v3/company/test-realm/query',
      { query: 'select * from Customer where Active in (true,false) maxresults 1000 startposition 1001' },
    );
  });
});
