import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { qboAuthService, type QboAuthService } from './auth.service';
import { QBO_CDC_ENTITIES, type QboCdcEntity } from './types';

export class QboApiError extends Error {
  public constructor(message: string, public readonly status: number) { super(message); this.name = 'QboApiError'; }
}

export class QboApiClient {
  private baseUrl = env.QBO_API_BASE_URL;

  public constructor(private readonly auth: Pick<QboAuthService, 'getValidAccessToken' | 'refreshAccessToken'> = qboAuthService) {}

  public async get<T>(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    const { accessToken } = await this.auth.getValidAccessToken();
    return this.getWithToken<T>(endpoint, params, accessToken);
  }

  public async getCdc<T>(entities: QboCdcEntity[], changedSince: string): Promise<T> {
    if (entities.length === 0 || entities.some((entity) => !(QBO_CDC_ENTITIES as readonly string[]).includes(entity))) {
      throw new Error('QuickBooks CDC requires one or more supported entities.');
    }
    if (!Number.isFinite(Date.parse(changedSince))) throw new Error('QuickBooks CDC changedSince must be a valid timestamp.');
    const { accessToken, realmId } = await this.auth.getValidAccessToken();
    return this.getWithToken<T>(
      '/v3/company/' + encodeURIComponent(realmId) + '/cdc',
      { entities: entities.join(','), changedSince },
      accessToken,
    );
  }

  private async getWithToken<T>(endpoint: string, params: Record<string, string | number | boolean>, accessToken: string): Promise<T> {
    // Construct URL with query parameters
    const url = new URL(`${this.baseUrl}${endpoint}`);
    
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.append(key, String(params[key]));
      }
    });

    try {
      let response = await this.fetchWithToken(url, accessToken);

      if (response.status === 401) {
        await response.text();
        try {
          await this.auth.refreshAccessToken(accessToken);
        } catch {
          logger.warn('[QuickBooks] Access-token refresh after HTTP 401 failed; persisted credentials were retained.');
          throw new QboApiError('QuickBooks authentication refresh failed.', 401);
        }
        const refreshed = await this.auth.getValidAccessToken();
        response = await this.fetchWithToken(url, refreshed.accessToken);
      }

      if (!response.ok) {
        await response.text();
        throw new QboApiError('QuickBooks API Error: [' + response.status + ']', response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      const statusMatch = error instanceof Error ? /\[(\d{3})\]/.exec(error.message) : null;
      logger.error(`[QuickBooks] GET ${endpoint} failed`, { status: statusMatch?.[1] });
      throw error;
    }
  }

  private fetchWithToken(url: URL, accessToken: string): Promise<Response> {
    return fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });
  }
}

export const qboApiClient = new QboApiClient();
