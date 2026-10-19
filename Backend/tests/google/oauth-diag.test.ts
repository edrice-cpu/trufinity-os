/**
 * Mocked tests for oauth-diag.ts.
 *
 * Verifies:
 *   1. gaxios global retry config is set to {retry:0, noResponseRetries:0} before authorize().
 *   2. authorize() is called exactly once per runDiagnostic() invocation.
 *   3. No gmail, DB, Anthropic, SMTP, or notification calls can occur (no real deps injected).
 *   4. No token, key, JWT, or raw provider error value appears in logged output.
 *   5. Success and failure diagnostic paths produce correct structured results.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { instance as gaxiosInstance } from 'gaxios';
import { runDiagnostic, PILOT_MAILBOX, type DiagDeps } from '../../oauth-diag';
import { GMAIL_READONLY_SCOPE } from '../../src/modules/google/google-auth.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JestMock = jest.MockedFunction<(...args: any[]) => any>;

function makeAuth(overrides?: { authorize?: JestMock }) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return { authorize: overrides?.authorize ?? (jest.fn(() => Promise.resolve()) as JestMock) };
}

function makeAuthorization(authOverrides?: { authorize?: JestMock }) {
  const auth = makeAuth(authOverrides);
  return {
    client: {} as never,
    auth,
    mailbox: { normalizedAddress: PILOT_MAILBOX, contentMode: 'CONTENT' as const } as never,
    subject: PILOT_MAILBOX,
    scope: GMAIL_READONLY_SCOPE,
  };
}

function makeDeps(overrides?: Partial<DiagDeps> & { authOverrides?: { authorize?: JestMock } }): {
  deps: DiagDeps;
  logs: string[];
  getAuthorization: JestMock;
  authorizeFn: JestMock;
} {
  const logs: string[] = [];
  const authorization = makeAuthorization(overrides?.authOverrides);
  const getAuthorization = jest.fn().mockReturnValue(authorization) as JestMock;
  const deps: DiagDeps = {
    getAuthorization: getAuthorization as DiagDeps['getAuthorization'],
    saEmail: 'sa@test-project.iam.gserviceaccount.com',
    privateKeyLength: 1700,
    privateKeyHeader: '-----BEGIN RSA PR',
    adminDelegatedUser: 'admin@trufinity.ca',
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs, getAuthorization, authorizeFn: authorization.auth.authorize as JestMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runDiagnostic — retry config', () => {
  it('sets gaxios global retryConfig to {retry:0, noResponseRetries:0} before authorize()', async () => {
    let retryConfigAtCallTime: unknown;
    const authorizeFn = jest.fn().mockImplementation(async () => {
      retryConfigAtCallTime = { ...gaxiosInstance.defaults?.retryConfig };
    });
    const { deps } = makeDeps({ authOverrides: { authorize: authorizeFn } });

    await runDiagnostic(deps);

    expect(retryConfigAtCallTime).toEqual({ retry: 0, noResponseRetries: 0 });
  });
});

describe('runDiagnostic — single authorize() call', () => {
  it('calls authorize() exactly once on success', async () => {
    const { deps, authorizeFn } = makeDeps();
    await runDiagnostic(deps);
    expect(authorizeFn).toHaveBeenCalledTimes(1);
  });

  it('calls authorize() exactly once on failure', async () => {
    const gaxiosErr = Object.assign(new Error('invalid_grant'), { name: 'GaxiosError', response: { status: 400 } });
    const authorizeFn = jest.fn(() => Promise.reject(gaxiosErr)) as JestMock;
    const { deps } = makeDeps({ authOverrides: { authorize: authorizeFn } });

    await runDiagnostic(deps);

    expect(authorizeFn).toHaveBeenCalledTimes(1);
  });
});

describe('runDiagnostic — correct pilot mailbox and subject', () => {
  it('passes PILOT_MAILBOX to getAuthorization', async () => {
    const { deps, deps: { getAuthorization } } = makeDeps();
    await runDiagnostic(deps);
    expect(getAuthorization).toHaveBeenCalledWith(PILOT_MAILBOX);
    expect(PILOT_MAILBOX).toBe('service@trufinity.ca');
  });
});

describe('runDiagnostic — success path', () => {
  it('returns outcome SUCCESS', async () => {
    const { deps } = makeDeps();
    const result = await runDiagnostic(deps);
    expect(result.outcome).toBe('SUCCESS');
  });

  it('does not log any token value', async () => {
    const authorizeFn = jest.fn().mockImplementation(async function (this: unknown) {
      // Simulate credentials being set on the JWT object after authorize()
      (this as Record<string, unknown>)['credentials'] = { access_token: 'secret-token-abc123' };
    });
    const { deps, logs } = makeDeps({ authOverrides: { authorize: authorizeFn } });
    await runDiagnostic(deps);

    const combined = logs.join('\n');
    expect(combined).not.toContain('secret-token-abc123');
    expect(combined).toContain('TOKEN_PRESENT');
  });

  it('logs [RESULT] OUTCOME: SUCCESS line', async () => {
    const { deps, logs } = makeDeps();
    await runDiagnostic(deps);
    expect(logs.some((l) => l.includes('[RESULT] OUTCOME: SUCCESS'))).toBe(true);
  });
});

describe('runDiagnostic — failure path categorization', () => {
  async function runWithError(err: unknown) {
    const authorizeFn = jest.fn(() => Promise.reject(err)) as JestMock;
    const { deps, logs } = makeDeps({ authOverrides: { authorize: authorizeFn } });
    const result = await runDiagnostic(deps);
    return { result, logs };
  }

  it('categorizes GaxiosError 401 as authentication', async () => {
    const err = Object.assign(new Error('Unauthorized'), { name: 'GaxiosError', response: { status: 401 } });
    const { result } = await runWithError(err);
    expect(result.outcome).toBe('FAILED');
    expect(result.category).toBe('authentication');
    expect(result.httpStatus).toBe(401);
  });

  it('categorizes 403 as permission_or_scope', async () => {
    const err = Object.assign(new Error('Forbidden'), { name: 'GaxiosError', response: { status: 403 } });
    const { result } = await runWithError(err);
    expect(result.category).toBe('permission_or_scope');
  });

  it('categorizes google-auth-library wrapper "Could not refresh access token" as authentication', async () => {
    const { result } = await runWithError(new Error('Could not refresh access token.'));
    expect(result.category).toBe('authentication');
    expect(result.httpStatus).toBeNull();
  });

  it('categorizes "Error fetching access token: unauthorized_client" as authentication', async () => {
    const { result } = await runWithError(new Error('Error fetching access token: unauthorized_client'));
    expect(result.category).toBe('authentication');
  });

  it('categorizes "Token has been expired or revoked." as authentication', async () => {
    const { result } = await runWithError(new Error('Token has been expired or revoked.'));
    expect(result.category).toBe('authentication');
  });

  it('categorizes ETIMEDOUT as network', async () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const { result } = await runWithError(err);
    expect(result.category).toBe('network');
  });

  it('does not log the raw error message or any stack trace', async () => {
    const err = Object.assign(new Error('secret-internal-error-detail'), { name: 'GaxiosError', response: { status: 400 } });
    const { logs } = await runWithError(err);
    const combined = logs.join('\n');
    expect(combined).not.toContain('secret-internal-error-detail');
    expect(combined).not.toContain('stack');
  });

  it('logs stage as oauth_token_acquisition', async () => {
    const { logs } = await runWithError(new Error('invalid_grant'));
    expect(logs.some((l) => l.includes('oauth_token_acquisition'))).toBe(true);
  });
});

describe('runDiagnostic — no side effects possible', () => {
  it('never calls getAuthorization with any address other than PILOT_MAILBOX', async () => {
    const { deps, getAuthorization } = makeDeps();
    await runDiagnostic(deps);
    const calls = getAuthorization.mock.calls as string[][];
    expect(calls.every((args) => args[0] === PILOT_MAILBOX)).toBe(true);
  });

  it('only calls authorize() on the returned auth object, nothing else on the client', async () => {
    const clientSpy = { users: { messages: { get: jest.fn() } } };
    // Override to return a client with spied methods
    const { deps, getAuthorization } = makeDeps();
    getAuthorization.mockReturnValue({
      ...makeAuthorization(),
      client: clientSpy,
    });
    await runDiagnostic(deps);
    expect(clientSpy.users.messages.get).not.toHaveBeenCalled();
  });

  it('returns SETUP_ERROR if authorize is not a function', async () => {
    const { deps, getAuthorization } = makeDeps();
    getAuthorization.mockReturnValue({
      ...makeAuthorization(),
      auth: {},
    });
    const result = await runDiagnostic(deps);
    expect(result.outcome).toBe('SETUP_ERROR');
  });
});
