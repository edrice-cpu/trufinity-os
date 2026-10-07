import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboQueryResponse, QboCustomer } from '../types';

export class QboCustomerService {
  public async getCustomersPage(position = 1, maxResults = 1000): Promise<QboQueryResponse<QboCustomer>> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const query = `select * from Customer where Active in (true,false) maxresults ${maxResults} startposition ${position}`;
    return qboApiClient.get<QboQueryResponse<QboCustomer>>(`/v3/company/${realmId}/query`, { query });
  }

  public async getCustomers(limit = 10): Promise<QboCustomer[]> {
    const response = await this.getCustomersPage(1, limit);
    return response.QueryResponse.Customer ?? [];
  }
}

export const qboCustomerService = new QboCustomerService();
