import { apiClient } from '../api.client';
import { Payment, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class PaymentService {
  public async getPayments(page = 1, pageSize = 50): Promise<PaginatedResponse<Payment>> {
    const endpoint = `/accounting/v2/tenant/${env.SERVICETITAN_TENANT_ID}/payments`;
    return apiClient.get<PaginatedResponse<Payment>>(endpoint, { page, pageSize });
  }
}

export const paymentService = new PaymentService();
