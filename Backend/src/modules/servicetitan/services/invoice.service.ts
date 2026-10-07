import { apiClient } from '../api.client';
import { Invoice, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class InvoiceService {
  public async getInvoices(page = 1, pageSize = 50): Promise<PaginatedResponse<Invoice>> {
    const endpoint = `/accounting/v2/tenant/${env.SERVICETITAN_TENANT_ID}/invoices`;
    return apiClient.get<PaginatedResponse<Invoice>>(endpoint, { page, pageSize });
  }
}

export const invoiceService = new InvoiceService();
