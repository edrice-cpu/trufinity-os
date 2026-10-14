import { env } from '../../../config/env';
import { apiClient as defaultApiClient, ServiceTitanApiClient } from '../api.client';

// Actual shape returned by GET /telecom/v2/tenant/{tenant}/calls/{id}.
// The response is a bundle wrapper — all call data lives in leadCall.
// Phone numbers (from/to) and media URLs are stripped before returning to callers.
// Customer PII (address, contacts, memberships, etc.) is reduced to id+name only.
interface RawLeadCall {
  id: number;
  receivedOn: string | null;
  modifiedOn: string | null;
  duration: string | null;
  direction: string;
  callType: string | null;
  reason: { id: number; name: string } | null;
  sid: string | null;
  agent: { id: number; name: string; externalId: string | null } | null;
  createdBy: { id: number; name: string } | null;
  campaign: { id: number; name?: string } | null;
  customer: { id: number; name: string; [key: string]: unknown } | null;
  tags: Array<{ id: number; name: string }>;
  // Intentionally omitted: from, to, recordingUrl, voiceMailUrl.
  [key: string]: unknown;
}

interface RawV2CallBundle {
  leadCall: RawLeadCall | null | undefined;
  id: number;           // always 0 — meaningless bundle surrogate
  jobNumber: string | null;
  projectId: number | null;
  businessUnit: { id: number; name: string } | null;
  type: string | null;
  [key: string]: unknown;
}

export interface V2CallDetails {
  // leadCall fields
  id: number;
  receivedOn: string | null;
  modifiedOn: string | null;
  duration: string | null;
  direction: string;
  callType: string | null;
  reason: { id: number; name: string } | null;
  sid: string | null;
  agent: { id: number; name: string; externalId: string | null } | null;
  createdBy: { id: number; name: string } | null;
  campaign: { id: number; name?: string } | null;
  customer: { id: number; name: string } | null;
  tags: Array<{ id: number; name: string }>;
  // bundle-level context fields
  jobNumber: string | null;
  projectId: number | null;
  businessUnit: { id: number; name: string } | null;
  type: string | null;
}

export class CallDetailsUpstreamError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'CallDetailsUpstreamError';
  }
}

export class CallDetailsMalformedError extends Error {
  public constructor(callId: string) {
    super(`ServiceTitan response for call ${callId} is missing leadCall.`);
    this.name = 'CallDetailsMalformedError';
  }
}

const STATUS_RE = /\[(\d{3})\]/;

function parseUpstreamStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = STATUS_RE.exec(err.message);
  return m ? parseInt(m[1]!, 10) : null;
}

function mapLeadCall(bundle: RawV2CallBundle, callId: string): V2CallDetails {
  const lc = bundle.leadCall;
  if (!lc || typeof lc !== 'object') {
    throw new CallDetailsMalformedError(callId);
  }

  // Customer: return only id+name to prevent PII leakage.
  const customer = lc.customer
    ? { id: lc.customer.id, name: lc.customer.name }
    : null;

  return {
    id: lc.id,
    receivedOn: lc.receivedOn ?? null,
    modifiedOn: lc.modifiedOn ?? null,
    duration: lc.duration ?? null,
    direction: lc.direction,
    callType: lc.callType ?? null,
    reason: lc.reason ?? null,
    sid: lc.sid ?? null,
    agent: lc.agent ?? null,
    createdBy: lc.createdBy ?? null,
    campaign: lc.campaign ?? null,
    customer,
    tags: Array.isArray(lc.tags) ? lc.tags : [],
    jobNumber: bundle.jobNumber ?? null,
    projectId: bundle.projectId ?? null,
    businessUnit: bundle.businessUnit ?? null,
    type: bundle.type ?? null,
  };
}

export class TelecomCallDetailsService {
  public constructor(
    private readonly apiClient: ServiceTitanApiClient = defaultApiClient,
  ) {}

  public async getCallDetails(callId: string): Promise<V2CallDetails> {
    const endpoint = `/telecom/v2/tenant/${env.SERVICETITAN_TENANT_ID}/calls/${callId}`;
    let bundle: RawV2CallBundle;
    try {
      bundle = await this.apiClient.get<RawV2CallBundle>(endpoint);
    } catch (err) {
      const status = parseUpstreamStatus(err);
      if (status === 404) {
        throw new CallDetailsUpstreamError(404, 'Call not found.');
      }
      if (status === 401 || status === 403) {
        throw new CallDetailsUpstreamError(502, 'ServiceTitan authentication failed.');
      }
      if (status === 429) {
        throw new CallDetailsUpstreamError(429, 'ServiceTitan rate limit exceeded. Please retry shortly.');
      }
      if (status !== null && status >= 500) {
        throw new CallDetailsUpstreamError(502, 'ServiceTitan service temporarily unavailable.');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CallDetailsUpstreamError(504, 'ServiceTitan request timed out.');
      }
      throw err;
    }
    return mapLeadCall(bundle, callId);
  }
}

export const telecomCallDetailsService = new TelecomCallDetailsService();
