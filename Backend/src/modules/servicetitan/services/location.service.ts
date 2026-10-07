import { apiClient } from '../api.client';
import { Location, PaginatedResponse } from '../types';
import { env } from '../../../config/env';

export class LocationService {
  public async getLocations(page = 1, pageSize = 50): Promise<PaginatedResponse<Location>> {
    const endpoint = `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/locations`;
    return apiClient.get<PaginatedResponse<Location>>(endpoint, { page, pageSize });
  }
}

export const locationService = new LocationService();
