import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboQueryResponse, QboAccount } from '../types';

export class QboAccountService {
  public async getAccountsPage(position = 1, maxResults = 1000): Promise<QboQueryResponse<QboAccount>> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const query = `select * from Account maxresults ${maxResults} startposition ${position}`;
    return qboApiClient.get<QboQueryResponse<QboAccount>>(`/v3/company/${realmId}/query`, { query });
  }

  public async getAccounts(limit = 10): Promise<QboAccount[]> {
    const response = await this.getAccountsPage(1, limit);
    return response.QueryResponse.Account ?? [];
  }
}

export const qboAccountService = new QboAccountService();
