import { apiClient } from '../api.client';
import { Lead, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class LeadService {
  public async getLeads(page = 1, pageSize = 50): Promise<PaginatedResponse<Lead>> {
    const endpoint = `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/leads`;
    return apiClient.get<PaginatedResponse<Lead>>(endpoint, { page, pageSize });
  }
}

export const leadService = new LeadService();
