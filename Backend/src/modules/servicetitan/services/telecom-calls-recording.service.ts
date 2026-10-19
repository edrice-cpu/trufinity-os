import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import { authService as defaultAuthService } from '../auth.service';
import { logger } from '../../../utils/logger';

const SOURCE_SYSTEM = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

// Validated call IDs are the sole input to these endpoint paths — never a client-supplied URL.
const stRecordingUrl = (callId: string): string =>
  `${env.SERVICETITAN_BASE_URL}/telecom/v2/tenant/${env.SERVICETITAN_TENANT_ID}/calls/${callId}/recording`;

const stVoicemailUrl = (callId: string): string =>
  `${env.SERVICETITAN_BASE_URL}/telecom/v2/tenant/${env.SERVICETITAN_TENANT_ID}/calls/${callId}/voicemail`;

// Timeout for the upstream ST request (headers + start of body).
// 30 s gives ample headroom for both recording and voicemail streams.
export const ST_RECORDING_TIMEOUT_MS = 30_000;

// Allowed content types from audio endpoints. Unexpected types (text/html,
// application/json) indicate an error page served with a 200 status.
const ALLOWED_AUDIO_PREFIXES = ['audio/', 'application/octet-stream'];

export type RecordingEligibility = 'eligible' | 'not_found' | 'no_recording';

export interface RecordingStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: string | null;
}

export class RecordingUpstreamError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'RecordingUpstreamError';
  }
}

// AuthService shape used by ServiceTitanTelecomCallsRecordingService.
// Only getAccessToken() is needed; the concrete AuthService satisfies this.
export interface STAuthService {
  getAccessToken(): Promise<string>;
}

export class TelecomCallsRecordingService {
  public constructor(
    private readonly database: Knex = db,
    private readonly stAuth: STAuthService = defaultAuthService,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  // Checks whether a call exists and has a recording URL in its stored payload.
  // Read-only — never touches the ST API.
  public async checkEligibility(callId: string): Promise<RecordingEligibility> {
    const row = await this.database('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM, source_id: callId, is_latest: true })
      .select(
        this.database.raw(
          `(payload->>'recordingUrl' IS NOT NULL AND (payload->>'recordingUrl') <> '') AS has_recording`,
        ),
      )
      .first() as { has_recording: boolean } | undefined;

    if (!row) return 'not_found';
    return row.has_recording ? 'eligible' : 'no_recording';
  }

  // Fetches the recording audio stream from ServiceTitan.
  public async fetchStream(callId: string, signal: AbortSignal): Promise<RecordingStream> {
    return this.fetchAudioStream(stRecordingUrl(callId), callId, 'Recording', signal, {
      notFound: 'Recording not available for this call.',
      authFailed: 'Recording service authentication failed.',
      badType: 'Unexpected response type from recording service.',
      noBody: 'Recording service returned an empty response body.',
      redirect: 'Unexpected redirect from upstream recording service.',
      unavailable: 'Recording service temporarily unavailable.',
      rateLimit: 'Recording service rate limit reached. Please try again shortly.',
    });
  }

  // Fetches the voicemail audio stream from ServiceTitan.
  // No DB eligibility check — a 404 from the API means no voicemail exists for this call.
  public async fetchVoicemailStream(callId: string, signal: AbortSignal): Promise<RecordingStream> {
    return this.fetchAudioStream(stVoicemailUrl(callId), callId, 'Voicemail', signal, {
      notFound: 'Voicemail not available for this call.',
      authFailed: 'Voicemail service authentication failed.',
      badType: 'Unexpected response type from voicemail service.',
      noBody: 'Voicemail service returned an empty response body.',
      redirect: 'Unexpected redirect from upstream voicemail service.',
      unavailable: 'Voicemail service temporarily unavailable.',
      rateLimit: 'Voicemail service rate limit reached. Please try again shortly.',
    });
  }

  // Shared streaming logic for recording and voicemail endpoints.
  // Never follows redirects — the URL is always constructed server-side from a
  // validated numeric call ID, preventing SSRF if the ST response is tampered with.
  private async fetchAudioStream(
    url: string,
    callId: string,
    logPrefix: string,
    signal: AbortSignal,
    messages: { notFound: string; authFailed: string; badType: string; noBody: string; redirect: string; unavailable: string; rateLimit: string },
  ): Promise<RecordingStream> {
    const token = await this.stAuth.getAccessToken();

    const response = await this.fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'ST-App-Key': env.SERVICETITAN_APP_KEY,
        Accept: 'audio/mpeg, audio/wav, audio/*, application/octet-stream',
      },
      signal,
      redirect: 'manual',
    });

    // status=0 is what Node.js fetch returns for opaque redirects when redirect:'manual'
    const isRedirect = response.status === 0 || (response.status >= 300 && response.status < 400);
    if (isRedirect) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn(`[${logPrefix}Proxy] Unexpected redirect from ServiceTitan`, { callId, status: response.status });
      throw new RecordingUpstreamError(502, messages.redirect);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const upstreamStatus = response.status;
      logger.warn(`[${logPrefix}Proxy] ServiceTitan ${logPrefix.toLowerCase()} endpoint failed`, { callId, upstreamStatus });
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        throw new RecordingUpstreamError(502, messages.authFailed);
      }
      if (upstreamStatus === 404) {
        throw new RecordingUpstreamError(404, messages.notFound);
      }
      if (upstreamStatus === 429) {
        throw new RecordingUpstreamError(429, messages.rateLimit);
      }
      throw new RecordingUpstreamError(502, messages.unavailable);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isAllowedType = ALLOWED_AUDIO_PREFIXES.some((prefix) => contentType.startsWith(prefix));
    if (!isAllowedType) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn(`[${logPrefix}Proxy] Unexpected Content-Type from ServiceTitan`, { callId, contentType });
      throw new RecordingUpstreamError(502, messages.badType);
    }

    if (!response.body) {
      throw new RecordingUpstreamError(502, messages.noBody);
    }

    return {
      body: response.body as ReadableStream<Uint8Array>,
      contentType,
      contentLength: response.headers.get('content-length'),
    };
  }
}

export const telecomCallsRecordingService = new TelecomCallsRecordingService();
