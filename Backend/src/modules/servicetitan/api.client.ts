import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { authService } from './auth.service';

// Default timeout per request. Applies an AbortController signal so fetch()
// throws AbortError instead of hanging indefinitely on a slow server response.
// The probe completed in ~6 s; the failed 90-day request ran 22 s before the
// remote dropped the connection. 60 s gives 2.7× headroom for large pages.
const FETCH_TIMEOUT_MS = 60_000;

export class ServiceTitanApiClient {
  private baseUrl = env.SERVICETITAN_BASE_URL;

  public async get<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    const token = await authService.getAccessToken();
    const startMs = Date.now();

    // Construct URL with query parameters
    const url = new URL(`${this.baseUrl}${endpoint}`);

    // Add pagination or filter params
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.append(key, String(params[key]));
      }
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'ST-App-Key': env.SERVICETITAN_APP_KEY,
          'Accept': 'application/json',
        },
        signal: controller.signal,
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
      const durationMs = Date.now() - startMs;
      // Log the endpoint path only — no bearer token (header, not URL),
      // no query param values (may appear in URLs for other endpoints).
      const code = (error as { code?: string }).code ?? null;
      const causeCode = error instanceof Error
        ? ((error.cause as { code?: string } | undefined)?.code ?? null)
        : null;
      const httpStatus = error instanceof Error
        ? (/\[(\d{3})\]/.exec(error.message)?.[1] ?? null)
        : null;
      logger.error(`[ServiceTitan] GET ${endpoint} failed`, {
        name: error instanceof Error ? error.name : 'UnknownError',
        code,
        causeCode,
        durationMs,
        ...(httpStatus !== null ? { httpStatus: parseInt(httpStatus, 10) } : {}),
      });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

export const apiClient = new ServiceTitanApiClient();
