/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { db } from '../../database';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

const parseTokenResponse = (value: unknown): TokenResponse => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed QuickBooks OAuth token response.');
  }
  const candidate = value as Partial<TokenResponse>;
  if (typeof candidate.access_token !== 'string' || candidate.access_token.trim() === ''
    || typeof candidate.refresh_token !== 'string' || candidate.refresh_token.trim() === ''
    || typeof candidate.expires_in !== 'number' || !Number.isFinite(candidate.expires_in) || candidate.expires_in <= 0
    || typeof candidate.x_refresh_token_expires_in !== 'number' || !Number.isFinite(candidate.x_refresh_token_expires_in) || candidate.x_refresh_token_expires_in <= 0) {
    throw new Error('Malformed QuickBooks OAuth token response.');
  }
  return candidate as TokenResponse;
};

export interface QboRefreshLock {
  acquire(): Promise<() => Promise<void>>;
}

const REFRESH_LOCK_KEY = 'QuickBooks:OAuthTokenRefresh';
const REFRESH_LOCK_MAX_ATTEMPTS = 100;
const REFRESH_LOCK_RETRY_MS = 100;
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PostgresQboRefreshLock implements QboRefreshLock {
  public constructor(
    private readonly database: Knex = db,
    private readonly maxAttempts = REFRESH_LOCK_MAX_ATTEMPTS,
    private readonly retryMilliseconds = REFRESH_LOCK_RETRY_MS,
  ) {}

  public async acquire(): Promise<() => Promise<void>> {
    const connection = await this.database.client.acquireConnection();
    let acquired = false;
    let connectionReleased = false;

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        const result = await this.database.raw(
          'SELECT pg_try_advisory_lock(hashtext(?)) AS locked',
          [REFRESH_LOCK_KEY],
        ).connection(connection);
        acquired = Array.isArray(result.rows) && result.rows[0]?.locked === true;
        if (acquired) break;
        if (attempt < this.maxAttempts - 1) await delay(this.retryMilliseconds);
      }

      if (!acquired) {
        await this.database.client.releaseConnection(connection);
        connectionReleased = true;
        throw new Error('QuickBooks OAuth refresh lock timed out.');
      }
    } catch (error) {
      if (!connectionReleased) {
        // A failed lock query can leave ownership uncertain; never return that
        // session to the pool where an advisory lock could leak to another task.
        await this.database.client.destroyRawConnection(connection).catch(() => undefined);
      }
      throw error;
    }

    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      try {
        const result = await this.database.raw(
          'SELECT pg_advisory_unlock(hashtext(?)) AS unlocked',
          [REFRESH_LOCK_KEY],
        ).connection(connection);
        if (!Array.isArray(result.rows) || result.rows[0]?.unlocked !== true) {
          throw new Error('PostgreSQL did not confirm QuickBooks OAuth refresh lock release.');
        }
        await this.database.client.releaseConnection(connection);
        released = true;
      } catch {
        await this.database.client.destroyRawConnection(connection).catch(() => undefined);
        released = true;
        throw new Error('QuickBooks OAuth refresh lock could not be safely released.');
      }
    };
  }
}

export interface QboAuthorizationState {
  expiresAt: number;
  returnToApp: boolean;
}

export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  accessTokenExpiry: number;
  refreshTokenExpiry: number;
}

export interface QboTokenStore {
  save(tokens: QboTokenSet): Promise<void>;
  load(): Promise<QboTokenSet | null>;
  clear(): Promise<void>;
}

class PostgresQboTokenStore implements QboTokenStore {
  public async save(tokens: QboTokenSet): Promise<void> {
    await db('qbo_oauth_tokens').insert({ realm_id: tokens.realmId, access_token: tokens.accessToken, refresh_token: tokens.refreshToken, access_token_expiry: tokens.accessTokenExpiry, refresh_token_expiry: tokens.refreshTokenExpiry }).onConflict('realm_id').merge({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, access_token_expiry: tokens.accessTokenExpiry, refresh_token_expiry: tokens.refreshTokenExpiry, updated_at: db.fn.now() });
  }
  public async load(): Promise<QboTokenSet | null> {
    const row = await db('qbo_oauth_tokens').orderBy('updated_at', 'desc').first();
    if (!row) return null;
    return { accessToken: String(row.access_token), refreshToken: String(row.refresh_token), realmId: String(row.realm_id), accessTokenExpiry: Number(row.access_token_expiry), refreshTokenExpiry: Number(row.refresh_token_expiry) };
  }
  public async clear(): Promise<void> { await db('qbo_oauth_tokens').delete(); }
}

export class QboAuthService {
  private tokenSet: QboTokenSet | null = null;
  private readonly pendingStates = new Map<string, QboAuthorizationState>();
  private refreshInFlight: Promise<void> | null = null;
  public constructor(
    private readonly tokenStore: QboTokenStore = new PostgresQboTokenStore(),
    private readonly refreshLock: QboRefreshLock = new PostgresQboRefreshLock(),
  ) {}
  private EXPIRY_BUFFER_MS = 60 * 1000;
  private OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

  /** `returnToApp` marks flows started from the web app so the callback redirects back to the UI. */
  public getAuthorizationUrl(options: { returnToApp?: boolean } = {}): string {
    const scope = encodeURIComponent('com.intuit.quickbooks.accounting');
    const redirectUri = encodeURIComponent(env.QBO_REDIRECT_URI);
    const state = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.OAUTH_STATE_TTL_MS;
    this.removeExpiredStates();
    this.pendingStates.set(state, { expiresAt, returnToApp: options.returnToApp ?? false });
    
    return `${env.QBO_AUTH_URL}?client_id=${env.QBO_CLIENT_ID}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
  }

  /** Returns the pending state (single use) or null when it is unknown or expired. */
  public consumeAuthorizationState(state: string): QboAuthorizationState | null {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return pending && pending.expiresAt > Date.now() ? pending : null;
  }

  public isConfigured(): boolean {
    return [env.QBO_CLIENT_ID, env.QBO_CLIENT_SECRET, env.QBO_AUTH_URL, env.QBO_TOKEN_URL, env.QBO_REDIRECT_URI]
      .every((value) => value.length > 0);
  }

  /** Durable connection details without exposing tokens. */
  public async getConnection(): Promise<{ realmId: string; refreshTokenExpiry: number } | null> {
    const stored = await this.tokenStore.load();
    return stored ? { realmId: stored.realmId, refreshTokenExpiry: stored.refreshTokenExpiry } : null;
  }

  public async disconnect(): Promise<boolean> {
    const stored = await this.tokenStore.load();
    if (!stored) {
      this.tokenSet = null;
      return false;
    }

    const authHeader = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(env.QBO_REVOKE_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`,
      },
      body: new URLSearchParams({ token: stored.refreshToken }),
    });

    if (!response.ok) {
      await response.text();
      logger.error('[QuickBooks] Token revocation failed', { status: response.status });
      throw new Error('QuickBooks disconnect failed.');
    }

    this.tokenSet = null;
    await this.tokenStore.clear();
    logger.info('[QuickBooks] QuickBooks connection disconnected');
    return true;
  }

  public async exchangeCodeForToken(code: string, realmId: string): Promise<void> {
    logger.info('[QuickBooks] Exchanging authorization code for tokens');
    
    const authHeader = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(env.QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.QBO_REDIRECT_URI
      })
    });

    if (!response.ok) {
      await response.text();
      logger.error('[QuickBooks] Token exchange failed', { status: response.status });
      throw new Error(`Failed to exchange code: ${response.status}`);
    }

    const data = parseTokenResponse(await response.json());
    await this.saveTokenSet(data, realmId);
  }

  public async refreshAccessToken(rejectedAccessToken?: string): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshOperation = this.performAccessTokenRefresh(rejectedAccessToken);
    this.refreshInFlight = refreshOperation;
    try {
      await refreshOperation;
    } finally {
      if (this.refreshInFlight === refreshOperation) this.refreshInFlight = null;
    }
  }

  private async performAccessTokenRefresh(rejectedAccessToken?: string): Promise<void> {
    const release = await this.refreshLock.acquire();
    try {
      // Another process may have refreshed and rotated credentials while this
      // process waited. Always use the latest durable token state under the lock.
      const stored = await this.tokenStore.load();
      if (!stored) throw new Error('No stored QuickBooks refresh token is available.');

      const tokenWasRotatedByAnotherProcess = rejectedAccessToken !== undefined
        && stored.accessToken !== rejectedAccessToken;
      if (stored.accessTokenExpiry > Date.now() + this.EXPIRY_BUFFER_MS
        && (rejectedAccessToken === undefined || tokenWasRotatedByAnotherProcess)) {
        this.tokenSet = stored;
        return;
      }

      logger.info('[QuickBooks] Refreshing access token');
      const authHeader = Buffer.from(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`).toString('base64');
      const response = await fetch(env.QBO_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authHeader}`,
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
      });

      if (!response.ok) {
        await response.text();
        logger.error('[QuickBooks] Token refresh failed', { status: response.status });
        throw new Error(`Failed to refresh token: ${response.status}`);
      }

      const data = parseTokenResponse(await response.json());
      await this.saveTokenSet(data, stored.realmId);
    } finally {
      await release();
    }
  }

  public async getValidAccessToken(): Promise<{ accessToken: string, realmId: string }> {
    this.tokenSet ??= await this.tokenStore.load();
    if (!this.tokenSet) {
      throw new Error('QuickBooks is not authenticated. Please authorize first.');
    }

    const now = Date.now();
    
    // Check if access token is expired or about to expire
    if (now > this.tokenSet.accessTokenExpiry - this.EXPIRY_BUFFER_MS) {
      await this.refreshAccessToken();
    }

    // Ensure we have a valid token set after potential refresh
    if (!this.tokenSet) {
      throw new Error('QuickBooks authentication failed during token refresh.');
    }

    return {
      accessToken: this.tokenSet.accessToken,
      realmId: this.tokenSet.realmId
    };
  }

  // Encapsulated setter to allow easy migration to DB later
  private async saveTokenSet(data: TokenResponse, realmId: string): Promise<void> {
    const now = Date.now();
    const updatedTokenSet: QboTokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      realmId: realmId,
      accessTokenExpiry: now + (data.expires_in * 1000),
      refreshTokenExpiry: now + (data.x_refresh_token_expires_in * 1000)
    };
    await this.tokenStore.save(updatedTokenSet);
    this.tokenSet = updatedTokenSet;
    logger.info('[QuickBooks] Token state saved securely');
  }

  public clearCache(): void {
    this.tokenSet = null;
  }

  private removeExpiredStates(): void {
    const now = Date.now();
    for (const [state, pending] of this.pendingStates.entries()) {
      if (pending.expiresAt <= now) this.pendingStates.delete(state);
    }
  }
}

export const qboAuthService = new QboAuthService();
