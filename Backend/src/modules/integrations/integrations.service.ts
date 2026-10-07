import type { Knex } from 'knex';
import { env } from '../../config/env';
import { db } from '../../database';
import { logger } from '../../utils/logger';
import { qboAuthService } from '../quickbooks/auth.service';
import { authService as serviceTitanAuthService } from '../servicetitan/auth.service';

const SERVICETITAN_CHECK_TIMEOUT_MS = 8_000;

export interface QuickBooksStatus {
  configured: boolean;
  connected: boolean;
  realmId: string | null;
  companyName: string | null;
  refreshTokenExpiresAt: string | null;
}

export interface ServiceTitanStatus {
  configured: boolean;
  connected: boolean;
  tenantId: string | null;
  connectUrl: string;
}

export interface IntegrationsStatus {
  quickbooks: QuickBooksStatus;
  servicetitan: ServiceTitanStatus;
}

type QboAuth = Pick<typeof qboAuthService, 'isConfigured' | 'getConnection' | 'getAuthorizationUrl'>;
type ServiceTitanAuth = Pick<typeof serviceTitanAuthService, 'getAccessToken'>;

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export class IntegrationsService {
  public constructor(
    private readonly qbo: QboAuth = qboAuthService,
    private readonly serviceTitan: ServiceTitanAuth = serviceTitanAuthService,
    private readonly database: Knex = db,
  ) {}

  public async getStatus(): Promise<IntegrationsStatus> {
    const [quickbooks, servicetitan] = await Promise.all([this.getQuickBooksStatus(), this.getServiceTitanStatus()]);
    return { quickbooks, servicetitan };
  }

  public getQuickBooksConnectUrl(): string {
    if (!this.qbo.isConfigured()) throw new Error('QuickBooks app credentials are not configured.');
    return this.qbo.getAuthorizationUrl({ returnToApp: true });
  }

  private async getQuickBooksStatus(): Promise<QuickBooksStatus> {
    const connection = await this.qbo.getConnection();
    // A stored connection is usable until its refresh token expires (Intuit refresh tokens last ~100 days).
    const connected = connection !== null && connection.refreshTokenExpiry > Date.now();
    return {
      configured: this.qbo.isConfigured(),
      connected,
      realmId: connection?.realmId ?? null,
      companyName: connection ? await this.findQuickBooksCompanyName(connection.realmId) : null,
      refreshTokenExpiresAt: connection ? new Date(connection.refreshTokenExpiry).toISOString() : null,
    };
  }

  private async findQuickBooksCompanyName(realmId: string): Promise<string | null> {
    const row = await this.database('raw_qbo_companyinfo')
      .where({ source_id: realmId, is_latest: true })
      .first<{ company_name: string | null } | undefined>(this.database.raw("payload->>'CompanyName' as company_name"));
    return row?.company_name ?? null;
  }

  private async getServiceTitanStatus(): Promise<ServiceTitanStatus> {
    const configured = [
      env.SERVICETITAN_CLIENT_ID, env.SERVICETITAN_CLIENT_SECRET, env.SERVICETITAN_APP_KEY,
      env.SERVICETITAN_AUTH_URL, env.SERVICETITAN_BASE_URL, env.SERVICETITAN_TENANT_ID,
    ].every((value) => value.length > 0);

    let connected = false;
    if (configured) {
      // ServiceTitan uses client credentials, so "connected" means the tenant-issued credentials still mint tokens.
      try {
        await withTimeout(this.serviceTitan.getAccessToken(), SERVICETITAN_CHECK_TIMEOUT_MS);
        connected = true;
      } catch {
        logger.warn('[Integrations] ServiceTitan connection check failed');
      }
    }

    return {
      configured,
      connected,
      tenantId: env.SERVICETITAN_TENANT_ID || null,
      connectUrl: env.SERVICETITAN_CONNECT_URL,
    };
  }
}

export const integrationsService = new IntegrationsService();
