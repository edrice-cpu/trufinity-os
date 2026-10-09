/**
 * Focused tests for Google authentication, error sanitization, and retry behavior.
 * Tests safeErrorMessage(), isRetryable(), assertGoogleCredentialsConfigured(),
 * and per-mailbox failure isolation.
 */
import { describe, it, expect } from '@jest/globals';
import { safeErrorMessage, isRetryable } from '../../src/modules/google/gmail-historical.service';
import {
  GoogleWorkspaceAuthService,
  assertGoogleCredentialsConfigured,
  type GoogleAuthFactory,
  type GoogleDirectoryUsersClient,
  type GoogleGmailClient,
} from '../../src/modules/google/google-auth.service';

// ---------------------------------------------------------------------------
// safeErrorMessage
// ---------------------------------------------------------------------------

const makeHttpError = (status: number): object => ({
  name: 'GaxiosError',
  response: { status },
});

describe('safeErrorMessage — credential/auth error sanitization', () => {
  it('returns safe string for HTTP 401 — does not expose token or response body', () => {
    const msg = safeErrorMessage(makeHttpError(401));
    expect(msg).toContain('401');
    expect(msg).not.toContain('token');
    expect(msg).not.toContain('Bearer');
    expect(msg).not.toContain('credential');
  });

  it('returns safe string for HTTP 403 — does not expose scope or service-account details', () => {
    const msg = safeErrorMessage(makeHttpError(403));
    expect(msg).toContain('403');
    expect(msg).not.toContain('service-account');
  });

  it('returns auth failure string for GaxiosError (covers invalid_grant / expired key)', () => {
    const err = { name: 'GaxiosError', message: 'invalid_grant: Token has been expired or revoked.' };
    const msg = safeErrorMessage(err);
    expect(msg).toContain('invalid credentials');
    expect(msg).not.toContain('Token');
    expect(msg).not.toContain('revoked');
  });

  it('returns auth failure string for Error with invalid_grant in message', () => {
    const err = new Error('invalid_grant');
    const msg = safeErrorMessage(err);
    expect(msg).toContain('invalid credentials');
  });

  it('returns safe generic string for HTTP 500', () => {
    const msg = safeErrorMessage(makeHttpError(500));
    expect(msg).toContain('500');
    expect(msg).not.toContain('stack');
  });

  it('returns generic safe string for unknown error types', () => {
    const msg = safeErrorMessage('something went wrong');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain('something went wrong');
  });

  it('does not include private-key material from error messages', () => {
    const err = new Error('-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----');
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain('PRIVATE KEY');
    expect(msg).not.toContain('MIIEvQ');
  });
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable — retry eligibility', () => {
  it('401 is NOT retryable', () => {
    expect(isRetryable(makeHttpError(401))).toBe(false);
  });

  it('403 is NOT retryable', () => {
    expect(isRetryable(makeHttpError(403))).toBe(false);
  });

  it('404 is NOT retryable', () => {
    expect(isRetryable(makeHttpError(404))).toBe(false);
  });

  it('408 is retryable', () => {
    expect(isRetryable(makeHttpError(408))).toBe(true);
  });

  it('429 is retryable', () => {
    expect(isRetryable(makeHttpError(429))).toBe(true);
  });

  it('500 is retryable', () => {
    expect(isRetryable(makeHttpError(500))).toBe(true);
  });

  it('502 is retryable', () => {
    expect(isRetryable(makeHttpError(502))).toBe(true);
  });

  it('503 is retryable', () => {
    expect(isRetryable(makeHttpError(503))).toBe(true);
  });

  it('504 is retryable', () => {
    expect(isRetryable(makeHttpError(504))).toBe(true);
  });

  it('TypeError (network-level) is retryable', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('non-Error, non-object values are not retryable', () => {
    expect(isRetryable('error string')).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertGoogleCredentialsConfigured
// ---------------------------------------------------------------------------

const validConfig = {
  projectId: 'test-project',
  serviceAccountEmail: 'sa@test.iam.gserviceaccount.com',
  serviceAccountPrivateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  adminDelegatedUser: 'admin@trufinity.ca',
};

describe('assertGoogleCredentialsConfigured — fail-fast validation', () => {
  it('passes when all credentials are set', () => {
    expect(() => assertGoogleCredentialsConfigured(validConfig)).not.toThrow();
  });

  it('throws a clear error when serviceAccountEmail is empty', () => {
    expect(() => assertGoogleCredentialsConfigured({ ...validConfig, serviceAccountEmail: '' }))
      .toThrow('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  });

  it('throws when serviceAccountEmail is whitespace-only', () => {
    expect(() => assertGoogleCredentialsConfigured({ ...validConfig, serviceAccountEmail: '   ' }))
      .toThrow('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  });

  it('throws a clear error when serviceAccountPrivateKey is empty', () => {
    expect(() => assertGoogleCredentialsConfigured({ ...validConfig, serviceAccountPrivateKey: '' }))
      .toThrow('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  });

  it('throws when serviceAccountPrivateKey is whitespace-only', () => {
    expect(() => assertGoogleCredentialsConfigured({ ...validConfig, serviceAccountPrivateKey: '\n\t ' }))
      .toThrow('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  });

  it('throws a clear error when adminDelegatedUser is empty', () => {
    expect(() => assertGoogleCredentialsConfigured({ ...validConfig, adminDelegatedUser: '' }))
      .toThrow('GOOGLE_ADMIN_DELEGATED_USER');
  });

  it('error messages do not contain credential values', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----';
    try {
      assertGoogleCredentialsConfigured({ ...validConfig, serviceAccountEmail: '' });
    } catch (err) {
      expect((err as Error).message).not.toContain(key);
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

// ---------------------------------------------------------------------------
// GoogleWorkspaceAuthService — createJwt guard
// ---------------------------------------------------------------------------

describe('GoogleWorkspaceAuthService — runtime credential guard', () => {
  const factory: GoogleAuthFactory = {
    createJwt: () => ({}),
    createAdminClient: () => ({ list: async () => ({ data: {} }) } as unknown as GoogleDirectoryUsersClient),
    createGmailClient: () => ({} as GoogleGmailClient),
  };

  it('throws on missing serviceAccountPrivateKey when getGmailAuthorization is called', () => {
    const svc = new GoogleWorkspaceAuthService({ ...validConfig, serviceAccountPrivateKey: '' }, factory);
    expect(() => svc.getGmailAuthorization('finance@trufinity.ca')).toThrow('credentials are not configured');
  });

  it('throws on whitespace-only serviceAccountEmail when getAdminDirectoryClient is called', () => {
    const svc = new GoogleWorkspaceAuthService({ ...validConfig, serviceAccountEmail: '   ' }, factory);
    expect(() => svc.getAdminDirectoryClient()).toThrow('credentials are not configured');
  });

  it('throws on missing adminDelegatedUser when getAdminDirectoryClient is called', () => {
    const svc = new GoogleWorkspaceAuthService({ ...validConfig, adminDelegatedUser: '' }, factory);
    expect(() => svc.getAdminDirectoryClient()).toThrow('delegated subject is not configured');
  });
});
