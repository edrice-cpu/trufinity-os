import { apiClient } from '../api.client';
import { Job, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class JobService {
  public async getJobs(page = 1, pageSize = 50): Promise<PaginatedResponse<Job>> {
    const endpoint = `/jpm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/jobs`;
    return apiClient.get<PaginatedResponse<Job>>(endpoint, { page, pageSize });
  }
}

export const jobService = new JobService();
