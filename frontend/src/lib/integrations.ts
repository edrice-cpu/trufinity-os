import "server-only";
import { backendFetch } from "./auth/backend";

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

export type IntegrationsStatusResult =
  | { kind: "ok"; status: IntegrationsStatus }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

export async function getIntegrationsStatus(token: string): Promise<IntegrationsStatusResult> {
  try {
    const response = await backendFetch<IntegrationsStatus>("/api/integrations/status", { token });
    if (response.status === 401) return { kind: "unauthenticated" };
    if (!response.ok || !response.data?.quickbooks || !response.data.servicetitan) return { kind: "unavailable" };
    return { kind: "ok", status: { quickbooks: response.data.quickbooks, servicetitan: response.data.servicetitan } };
  } catch {
    return { kind: "unavailable" };
  }
}
