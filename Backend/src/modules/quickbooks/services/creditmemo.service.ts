import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboQueryResponse, QboCreditMemo } from '../types';

export class QboCreditMemoService {
  public async getCreditMemosPage(position = 1, maxResults = 1000): Promise<QboQueryResponse<QboCreditMemo>> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const query = `select * from CreditMemo maxresults ${maxResults} startposition ${position}`;
    return qboApiClient.get<QboQueryResponse<QboCreditMemo>>(`/v3/company/${realmId}/query`, { query });
  }

  public async getCreditMemos(limit = 10): Promise<QboCreditMemo[]> {
    const response = await this.getCreditMemosPage(1, limit);
    return response.QueryResponse.CreditMemo ?? [];
  }
}

export const qboCreditMemoService = new QboCreditMemoService();
