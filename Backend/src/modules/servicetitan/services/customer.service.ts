import { apiClient } from '../api.client';
import { Customer, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class CustomerService {
  public async getCustomers(page = 1, pageSize = 50): Promise<PaginatedResponse<Customer>> {
    const endpoint = `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/customers`;
    return apiClient.get<PaginatedResponse<Customer>>(endpoint, { page, pageSize });
  }
}

export const customerService = new CustomerService();
