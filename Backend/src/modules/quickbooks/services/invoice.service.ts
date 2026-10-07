import { qboApiClient } from '../api.client';
import { qboAuthService } from '../auth.service';
import { QboQueryResponse, QboInvoice } from '../types';

export class QboInvoiceService {
  public async getInvoicesPage(position = 1, maxResults = 1000): Promise<QboQueryResponse<QboInvoice>> {
    const { realmId } = await qboAuthService.getValidAccessToken();
    const query = `select * from Invoice maxresults ${maxResults} startposition ${position}`;
    return qboApiClient.get<QboQueryResponse<QboInvoice>>(`/v3/company/${realmId}/query`, { query });
  }

  public async getInvoices(limit = 10): Promise<QboInvoice[]> {
    const response = await this.getInvoicesPage(1, limit);
    return response.QueryResponse.Invoice ?? [];
  }
}

export const qboInvoiceService = new QboInvoiceService();
