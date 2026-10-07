import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { generateToken, hashPassword, hashToken, verifyAgainstDummyHash, verifyPassword } from './auth.crypto';
import { SmtpAuthMailer, type AuthMailer } from './auth.mailer';
import { KnexAuthRepository, type AuthRepository } from './auth.repository';
import {
  normalizeEmail, toPublicUser,
  type AuthenticatedSession, type PublicUser, type RequestContext, type SessionResult,
} from './auth.types';

const MAX_RESET_REQUESTS_PER_HOUR = 3;

export class AuthError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceOptions {
  sessionTtlHours: number;
  passwordResetTtlMinutes: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  appBaseUrl: string;
}

export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.';
export const INVALID_RESET_TOKEN_MESSAGE = 'This password reset link is invalid or has expired. Please request a new one.';

export class AuthService {
  public constructor(
    private readonly repository: AuthRepository = new KnexAuthRepository(),
    private readonly mailer: AuthMailer = new SmtpAuthMailer(),
    private readonly options: AuthServiceOptions = {
      sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
      passwordResetTtlMinutes: env.AUTH_PASSWORD_RESET_TTL_MINUTES,
      maxFailedLogins: env.AUTH_MAX_FAILED_LOGINS,
      lockoutMinutes: env.AUTH_LOCKOUT_MINUTES,
      appBaseUrl: env.APP_BASE_URL,
    },
  ) {}

  public async login(email: string, password: string, context: RequestContext): Promise<SessionResult> {
    const user = await this.repository.findUserByEmail(normalizeEmail(email));

    // Every failure path spends the same hashing cost and returns the same message to prevent account enumeration.
    if (!user?.isActive) {
      await verifyAgainstDummyHash(password);
      throw new AuthError(401, INVALID_CREDENTIALS_MESSAGE);
    }

    const isLocked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (isLocked) {
      logger.warn(`[Auth] Login rejected for locked account ${user.id}`);
      throw new AuthError(401, INVALID_CREDENTIALS_MESSAGE);
    }
    if (!passwordMatches) {
      await this.repository.recordFailedLogin(user.id, this.options.maxFailedLogins, this.options.lockoutMinutes);
      logger.warn(`[Auth] Failed login for account ${user.id}`);
      throw new AuthError(401, INVALID_CREDENTIALS_MESSAGE);
    }

    await this.repository.recordSuccessfulLogin(user.id);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.options.sessionTtlHours * 60 * 60 * 1000);
    await this.repository.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    logger.info(`[Auth] Successful login for account ${user.id}`);
    return { token, expiresAt, user: toPublicUser(user) };
  }

  public async authenticate(token: string): Promise<AuthenticatedSession | null> {
    if (!token) return null;
    return this.repository.findActiveSession(hashToken(token));
  }

  public async logout(token: string): Promise<void> {
    if (!token) return;
    await this.repository.revokeSession(hashToken(token));
  }

  /**
   * Issues a reset link when the email belongs to an active account. Callers must respond identically
   * regardless of outcome, so this method never reveals whether the account exists.
   */
  public async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    const user = await this.repository.findUserByEmail(normalizeEmail(email));
    if (!user?.isActive) return;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (await this.repository.countResetRequestsSince(user.id, oneHourAgo) >= MAX_RESET_REQUESTS_PER_HOUR) {
      logger.warn(`[Auth] Password reset request throttled for account ${user.id}`);
      return;
    }

    const token = generateToken();
    await this.repository.createPasswordResetToken({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + this.options.passwordResetTtlMinutes * 60 * 1000),
      requestedIp: context.ipAddress,
    });

    // The token travels in the URL fragment so it is never sent to servers, proxies, or Referer headers.
    const resetUrl = `${this.options.appBaseUrl}/reset-password#token=${token}`;
    await this.mailer.sendPasswordResetEmail(user.email, resetUrl, this.options.passwordResetTtlMinutes);
    logger.info(`[Auth] Password reset email issued for account ${user.id}`);
  }

  public async resetPassword(token: string, newPassword: string): Promise<PublicUser> {
    const passwordHash = await hashPassword(newPassword);
    const user = await this.repository.resetPasswordWithToken(hashToken(token), passwordHash);
    if (!user) throw new AuthError(400, INVALID_RESET_TOKEN_MESSAGE);

    logger.info(`[Auth] Password reset completed for account ${user.id}; all sessions revoked`);
    this.mailer.sendPasswordChangedEmail(user.email).catch(() => {
      logger.error(`[Auth] Failed to send password-changed notification for account ${user.id}`);
    });
    return user;
  }
}

export const authService = new AuthService();
