/**
 * OAuth token acquisition diagnostic — single-attempt, read-only.
 *
 * Run (from Backend/):
 *   npx ts-node oauth-diag.ts
 *
 * Safety contract:
 *   - Exactly one authorize() call; retries explicitly disabled at the gaxios
 *     transport level so at most one HTTP request reaches oauth2.googleapis.com.
 *   - No Gmail reads, DB writes, Anthropic calls, SMTP, notifications, or AWS.
 *   - No token, key, JWT, or raw provider response is ever logged.
 *   - JWT subject = mailbox address ('service@trufinity.ca'), identical to the
 *     production classify pipeline (not GOOGLE_ADMIN_DELEGATED_USER).
 */

import { instance as gaxiosInstance } from 'gaxios';
import type { GmailAuthorizationContext } from './src/modules/google/google-auth.service';

export const PILOT_MAILBOX = 'service@trufinity.ca';

export interface DiagDeps {
  getAuthorization: (mailbox: string) => GmailAuthorizationContext;
  saEmail: string;
  privateKeyLength: number;
  privateKeyHeader: string;
  adminDelegatedUser: string;
  log: (line: string) => void;
}

export interface DiagResult {
  outcome: 'SUCCESS' | 'FAILED' | 'SETUP_ERROR';
  tokenPresent?: boolean;
  stage?: string;
  category?: string;
  httpStatus?: number | null;
  errorClass?: string;
  elapsedMs: number;
}

function categorize(err: unknown): { category: string; status: number | null; cls: string } {
  if (!err || typeof err !== 'object') return { category: 'unknown', status: null, cls: 'none' };
  const e = err as Record<string, unknown>;
  const resp = e['response'] as Record<string, unknown> | undefined;
  const status =
    typeof resp?.['status'] === 'number' ? (resp['status'] as number)
    : typeof e['status'] === 'number' ? (e['status'] as number)
    : null;
  const code = typeof e['code'] === 'string' ? e['code'] : '';
  const cls = err instanceof Error ? err.name : 'ProviderError';
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (status === 401) return { category: 'authentication', status, cls };
  if (status === 403) return { category: 'permission_or_scope', status, cls };
  if (
    err instanceof TypeError ||
    ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
  )
    return { category: 'network', status, cls };
  if (
    cls === 'GaxiosError' ||
    /invalid_grant|unauthorized_client|authentication failed|could not refresh access token|error fetching access token|token has been expired|token has been revoked/.test(
      msg,
    )
  )
    return { category: 'authentication', status, cls };
  return { category: 'provider_unknown', status, cls };
}

export async function runDiagnostic(deps: DiagDeps): Promise<DiagResult> {
  const { getAuthorization, saEmail, privateKeyLength, privateKeyHeader, adminDelegatedUser, log } =
    deps;

  // ── Sanitized preflight ─────────────────────────────────────────────────────
  log('[PREFLIGHT] SA_EMAIL_DOMAIN: ' + (saEmail.split('@')[1] ?? '(none)'));
  log('[PREFLIGHT] KEY_PRESENT: ' + (privateKeyLength > 100));
  log('[PREFLIGHT] KEY_HEADER_OK: ' + privateKeyHeader.startsWith('-----BEGIN'));
  log('[PREFLIGHT] ADMIN_DELEGATED_DOMAIN: ' + (adminDelegatedUser.split('@')[1] ?? '(none)'));

  // ── Disable gaxios retries before any network call ──────────────────────────
  // gtoken (used internally by google-auth-library JWT) calls gaxios.request()
  // on the global instance. Setting retryConfig here caps total HTTP requests
  // to the token endpoint at 1, including on network failures.
  gaxiosInstance.defaults = {
    ...gaxiosInstance.defaults,
    retryConfig: { retry: 0, noResponseRetries: 0 },
  };

  // ── Build authorization context ─────────────────────────────────────────────
  const authorization = getAuthorization(PILOT_MAILBOX);
  log('[PREFLIGHT] JWT_SUBJECT: ' + authorization.subject);
  log('[PREFLIGHT] JWT_SCOPE: ' + authorization.scope);
  log('[PREFLIGHT] AUTH_FIELD_PRESENT: ' + (typeof authorization.auth === 'object'));

  const auth = authorization.auth;
  if (typeof auth.authorize !== 'function') {
    log('[ERROR] authorize() not available — run: npx tsc && node dist/oauth-diag.js');
    return { outcome: 'SETUP_ERROR', elapsedMs: 0 };
  }

  // ── Single authorize() call ─────────────────────────────────────────────────
  log('[DIAG] Calling authorize() — one attempt...');
  const t0 = Date.now();

  try {
    await auth.authorize();

    const jwt = auth as unknown as { credentials?: { access_token?: string } };
    const tokenPresent = !!(jwt.credentials?.access_token);

    log('[RESULT] OUTCOME: SUCCESS');
    log('[RESULT] TOKEN_PRESENT: ' + tokenPresent);
    log('[RESULT] ELAPSED_MS: ' + (Date.now() - t0));
    return { outcome: 'SUCCESS', tokenPresent, elapsedMs: Date.now() - t0 };
  } catch (err) {
    const { category, status, cls } = categorize(err);
    const elapsed = Date.now() - t0;

    log('[RESULT] OUTCOME: FAILED');
    log('[RESULT] STAGE: oauth_token_acquisition');
    log('[RESULT] CATEGORY: ' + category);
    log('[RESULT] HTTP_STATUS: ' + (status ?? 'unavailable'));
    log('[RESULT] ERROR_CLASS: ' + cls);
    log('[RESULT] ELAPSED_MS: ' + elapsed);
    return { outcome: 'FAILED', stage: 'oauth_token_acquisition', category, httpStatus: status, errorClass: cls, elapsedMs: elapsed };
  }
}

// ── Direct execution entry-point ────────────────────────────────────────────
if (require.main === module) {
  // Import production dependencies only when run directly — never from tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { env } = require('./src/config/env') as { env: Record<string, string> };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { googleWorkspaceAuthService } = require('./src/modules/google/google-auth.service') as {
    googleWorkspaceAuthService: { getGmailAuthorization: (m: string) => GmailAuthorizationContext };
  };

  const liveDeps: DiagDeps = {
    getAuthorization: (m) => googleWorkspaceAuthService.getGmailAuthorization(m),
    saEmail: env['GOOGLE_SERVICE_ACCOUNT_EMAIL'] ?? '',
    privateKeyLength: (env['GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'] ?? '').length,
    privateKeyHeader: (env['GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'] ?? '').slice(0, 20),
    adminDelegatedUser: env['GOOGLE_ADMIN_DELEGATED_USER'] ?? '',
    log: console.log,
  };

  runDiagnostic(liveDeps)
    .then(() => {
      console.log('[CONFIRM] No gmail reads. No DB writes. No notifications. No Anthropic calls.');
      process.exit(0);
    })
    .catch((e: unknown) => {
      console.error('[FATAL] Unexpected error in diagnostic runner:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
