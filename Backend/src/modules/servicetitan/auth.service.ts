import { env } from '../../config/env';
import { logger } from '../../utils/logger';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

class AuthService {
  private cachedToken: string | null = null;
  private tokenExpiryTime = 0;
  // Buffer of 60 seconds to refresh token before it actually expires
  private EXPIRY_BUFFER_MS = 60 * 1000;

  public async getAccessToken(): Promise<string> {
    const now = Date.now();

    // Return cached token if it is still valid
    if (this.cachedToken && this.tokenExpiryTime > now + this.EXPIRY_BUFFER_MS) {
      return this.cachedToken;
    }

    logger.info('[ServiceTitan] Fetching new access token via Client Credentials');

    try {
      const response = await fetch(env.SERVICETITAN_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: env.SERVICETITAN_CLIENT_ID,
          client_secret: env.SERVICETITAN_CLIENT_SECRET,
        }),
      });

      if (!response.ok) {
        logger.error('[ServiceTitan] Token request failed', { status: response.status });
        throw new Error(`Failed to fetch ServiceTitan token: ${response.status}`);
      }

      const data = (await response.json()) as TokenResponse;

      this.cachedToken = data.access_token;
      // Calculate expiry time (expires_in is in seconds)
      this.tokenExpiryTime = now + data.expires_in * 1000;

      logger.info('[ServiceTitan] Successfully acquired and cached new access token');

      return this.cachedToken;
    } catch (error) {
      logger.error('[ServiceTitan] Authentication error', error);
      throw error;
    }
  }

  // Exposed for testing
  public clearCache() {
    this.cachedToken = null;
    this.tokenExpiryTime = 0;
  }
}

export const authService = new AuthService();
