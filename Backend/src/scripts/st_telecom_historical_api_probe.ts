import { env } from '../config/env';
import { logger } from '../utils/logger';
import { apiClient } from '../modules/servicetitan/api.client';
import type { TelecomCallsExportApi, TelecomCallsExportResponse } from '../modules/servicetitan/ingestion/telecom-calls.ingestion';

// The from date used for this diagnostic probe.
// Must match the configured SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM.
const PROBE_FROM = '2026-07-10';

export interface HistoricalApiProbeResult {
  success: boolean;
  durationMs: number;
  recordCount: number | null;
  hasMore: boolean | null;
  hasContinueFrom: boolean | null;
  // Set on failure only — structured fields from the caught error
  errorName: string | null;
  errorCode: string | null;
  errorCauseCode: string | null;
  httpStatus: number | null;
}

export async function runHistoricalApiProbe(
  client: TelecomCallsExportApi = apiClient,
  from: string = PROBE_FROM,
): Promise<HistoricalApiProbeResult> {
  const endpoint = `/telecom/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/calls`;

  console.log('\n=== ServiceTitan Telecom Historical API Probe ===');
  console.log(`  Tenant ID : ${env.SERVICETITAN_TENANT_ID}`);
  console.log(`  Endpoint  : ${endpoint}`);
  console.log(`  from      : ${from}`);
  console.log('  (read-only — no DB writes, no checkpoint changes)');
  console.log('=================================================\n');

  const startMs = Date.now();

  try {
    const response = await client.get<TelecomCallsExportResponse>(endpoint, { from });
    const durationMs = Date.now() - startMs;

    const recordCount = Array.isArray(response.data) ? response.data.length : null;
    const hasMore = typeof response.hasMore === 'boolean' ? response.hasMore : null;
    const hasContinueFrom =
      typeof response.continueFrom === 'string' && response.continueFrom.trim().length > 0;

    logger.info('[TelecomHistoricalApiProbe] Request succeeded', {
      from,
      durationMs,
      recordCount,
      hasMore,
      hasContinueFrom,
    });

    console.log('=== Result ===');
    console.log(`  Status       : SUCCESS`);
    console.log(`  Duration     : ${(durationMs / 1000).toFixed(2)} s`);
    console.log(`  Records      : ${recordCount ?? '(unknown — response.data not an array)'}`);
    console.log(`  hasMore      : ${hasMore}`);
    console.log(`  continueFrom : ${hasContinueFrom ? '(present — not shown)' : '(absent)'}`);
    console.log('==============\n');

    return {
      success: true,
      durationMs,
      recordCount,
      hasMore,
      hasContinueFrom,
      errorName: null,
      errorCode: null,
      errorCauseCode: null,
      httpStatus: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorCode = (error as { code?: string }).code ?? null;
    const errorCauseCode = error instanceof Error
      ? ((error.cause as { code?: string } | undefined)?.code ?? null)
      : null;
    const httpStatusMatch = error instanceof Error
      ? /\[(\d{3})\]/.exec(error.message)
      : null;
    const httpStatus = httpStatusMatch ? parseInt(httpStatusMatch[1]!, 10) : null;

    logger.error('[TelecomHistoricalApiProbe] Request failed', {
      from,
      durationMs,
      errorName,
      errorCode,
      errorCauseCode,
      ...(httpStatus !== null ? { httpStatus } : {}),
    });

    console.log('=== Result ===');
    console.log(`  Status       : FAILED`);
    console.log(`  Duration     : ${(durationMs / 1000).toFixed(2)} s`);
    console.log(`  Error name   : ${errorName}`);
    console.log(`  Error code   : ${errorCode ?? '(none)'}`);
    console.log(`  Cause code   : ${errorCauseCode ?? '(none)'}`);
    console.log(`  HTTP status  : ${httpStatus ?? '(no HTTP response received)'}`);
    console.log('==============\n');

    return {
      success: false,
      durationMs,
      recordCount: null,
      hasMore: null,
      hasContinueFrom: null,
      errorName,
      errorCode,
      errorCauseCode,
      httpStatus,
    };
  }
}

async function main(): Promise<void> {
  const result = await runHistoricalApiProbe();
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) void main();
