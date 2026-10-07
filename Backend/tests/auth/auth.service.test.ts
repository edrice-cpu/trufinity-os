import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { hashPassword, hashToken } from '../../src/modules/auth/auth.crypto';
import {
  AuthError, AuthService, INVALID_CREDENTIALS_MESSAGE, INVALID_RESET_TOKEN_MESSAGE,
} from '../../src/modules/auth/auth.service';
import { createFakeMailer, extractResetToken, InMemoryAuthRepository, testOptions } from './auth.fakes';

// Real scrypt hashing (OWASP cost) takes ~0.5s per hash, well past Jest's 5s default under parallel load.
jest.setTimeout(60_000);

const PASSWORD = 'original-password-123';
const context = { ipAddress: '203.0.113.10', userAgent: 'jest' };
let passwordHash: string;

describe('AuthService', () => {
  let repository: InMemoryAuthRepository;
  let mailer: ReturnType<typeof createFakeMailer>;
  let service: AuthService;

  beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    repository.users.push({
      id: 'user-1', email: 'Owner@TruFinity.ca', normalizedEmail: 'owner@trufinity.ca', fullName: 'Owner',
      passwordHash, isActive: true, failedLoginAttempts: 0, lockedUntil: null,
    });
    mailer = createFakeMailer();
    service = new AuthService(repository, mailer, testOptions);
  });

  describe('login', () => {
    it('creates a hashed session for valid credentials using a case-insensitive email', async () => {
      const result = await service.login('  OWNER@trufinity.ca ', PASSWORD, context);
      expect(result.user).toEqual({ id: 'user-1', email: 'Owner@TruFinity.ca', fullName: 'Owner' });
      expect(repository.sessions).toHaveLength(1);
      expect(repository.sessions[0]?.tokenHash).toBe(hashToken(result.token));
      expect(repository.sessions[0]?.tokenHash).not.toBe(result.token);
      await expect(service.authenticate(result.token)).resolves.toMatchObject({ user: { id: 'user-1' } });
    });

    it('returns the same error for unknown emails, wrong passwords, and inactive users', async () => {
      await expect(service.login('nobody@trufinity.ca', PASSWORD, context)).rejects.toEqual(new AuthError(401, INVALID_CREDENTIALS_MESSAGE));
      await expect(service.login('owner@trufinity.ca', 'wrong-password-123', context)).rejects.toEqual(new AuthError(401, INVALID_CREDENTIALS_MESSAGE));
      repository.users[0]!.isActive = false;
      await expect(service.login('owner@trufinity.ca', PASSWORD, context)).rejects.toEqual(new AuthError(401, INVALID_CREDENTIALS_MESSAGE));
      expect(repository.sessions).toHaveLength(0);
    });

    it('locks the account after repeated failures and rejects even the correct password while locked', async () => {
      for (let attempt = 0; attempt < testOptions.maxFailedLogins; attempt += 1) {
        await expect(service.login('owner@trufinity.ca', 'wrong-password-123', context)).rejects.toBeInstanceOf(AuthError);
      }
      expect(repository.users[0]?.lockedUntil).not.toBeNull();
      await expect(service.login('owner@trufinity.ca', PASSWORD, context)).rejects.toEqual(new AuthError(401, INVALID_CREDENTIALS_MESSAGE));
      expect(repository.sessions).toHaveLength(0);
    });

    it('revokes the session on logout', async () => {
      const { token } = await service.login('owner@trufinity.ca', PASSWORD, context);
      await service.logout(token);
      await expect(service.authenticate(token)).resolves.toBeNull();
    });
  });

  describe('password reset', () => {
    it('does nothing observable for unknown or inactive accounts', async () => {
      await service.requestPasswordReset('nobody@trufinity.ca', context);
      repository.users[0]!.isActive = false;
      await service.requestPasswordReset('owner@trufinity.ca', context);
      expect(repository.resetTokens).toHaveLength(0);
      expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('emails a fragment-based link and stores only the token hash', async () => {
      await service.requestPasswordReset('owner@trufinity.ca', context);
      const [to, resetUrl, ttl] = mailer.sendPasswordResetEmail.mock.calls[0]!;
      expect(to).toBe('Owner@TruFinity.ca');
      expect(ttl).toBe(30);
      expect(resetUrl.startsWith('https://app.example.test/reset-password#token=')).toBe(true);
      const token = extractResetToken(resetUrl);
      expect(repository.resetTokens[0]?.tokenHash).toBe(hashToken(token));
    });

    it('invalidates older links when a new one is issued and throttles repeated requests', async () => {
      await service.requestPasswordReset('owner@trufinity.ca', context);
      await service.requestPasswordReset('owner@trufinity.ca', context);
      const firstToken = extractResetToken(mailer.sendPasswordResetEmail.mock.calls[0]![1]);
      await expect(service.resetPassword(firstToken, 'brand-new-password-1')).rejects.toEqual(new AuthError(400, INVALID_RESET_TOKEN_MESSAGE));

      await service.requestPasswordReset('owner@trufinity.ca', context);
      await service.requestPasswordReset('owner@trufinity.ca', context);
      expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(3);
    });

    it('resets the password once, clears lockout, revokes sessions, and notifies the user', async () => {
      const { token: sessionToken } = await service.login('owner@trufinity.ca', PASSWORD, context);
      repository.users[0]!.lockedUntil = new Date(Date.now() + 60_000);
      await service.requestPasswordReset('owner@trufinity.ca', context);
      const resetToken = extractResetToken(mailer.sendPasswordResetEmail.mock.calls[0]![1]);

      await service.resetPassword(resetToken, 'brand-new-password-1');

      await expect(service.authenticate(sessionToken)).resolves.toBeNull();
      await expect(service.login('owner@trufinity.ca', PASSWORD, context)).rejects.toBeInstanceOf(AuthError);
      await expect(service.login('owner@trufinity.ca', 'brand-new-password-1', context)).resolves.toMatchObject({ user: { id: 'user-1' } });
      expect(mailer.sendPasswordChangedEmail).toHaveBeenCalledWith('Owner@TruFinity.ca');
      await expect(service.resetPassword(resetToken, 'another-password-12')).rejects.toEqual(new AuthError(400, INVALID_RESET_TOKEN_MESSAGE));
    });

    it('rejects expired reset tokens', async () => {
      await service.requestPasswordReset('owner@trufinity.ca', context);
      const resetToken = extractResetToken(mailer.sendPasswordResetEmail.mock.calls[0]![1]);
      repository.resetTokens[0]!.expiresAt = new Date(Date.now() - 1000);
      await expect(service.resetPassword(resetToken, 'brand-new-password-1')).rejects.toEqual(new AuthError(400, INVALID_RESET_TOKEN_MESSAGE));
    });
  });
});
