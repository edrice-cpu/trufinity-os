import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { authService } from './auth.service';

export class ServiceTitanApiClient {
  private baseUrl = env.SERVICETITAN_BASE_URL;

  public async get<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const token = await authService.getAccessToken();

    // Construct URL with query parameters
    const url = new URL(`${this.baseUrl}${endpoint}`);
    
    // Add pagination or filter params
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.append(key, String(params[key]));
      }
    });

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': env.SERVICETITAN_APP_KEY,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          logger.warn('[ServiceTitan] Token unauthorized. Clearing cache.');
          authService.clearCache();
        }
        
        if (response.status === 429) {
          logger.warn('[ServiceTitan] Rate limit exceeded');
        }

        // Provider response bodies can contain sensitive information. Keep the
        // error deliberately limited to the HTTP status.
        throw new Error(`ServiceTitan API Error: [${response.status}]`);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error(`[ServiceTitan] GET ${endpoint} failed`, error);
      throw error;
    }
  }
}

export const apiClient = new ServiceTitanApiClient();
