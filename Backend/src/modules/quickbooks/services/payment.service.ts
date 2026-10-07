import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboQueryResponse, QboPayment } from '../types';

export class QboPaymentService {
  public async getPaymentsPage(position = 1, maxResults = 1000): Promise<QboQueryResponse<QboPayment>> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const query = `select * from Payment maxresults ${maxResults} startposition ${position}`;
    return qboApiClient.get<QboQueryResponse<QboPayment>>(`/v3/company/${realmId}/query`, { query });
  }

  public async getPayments(limit = 10): Promise<QboPayment[]> {
    const response = await this.getPaymentsPage(1, limit);
    return response.QueryResponse.Payment ?? [];
  }
}

export const qboPaymentService = new QboPaymentService();
