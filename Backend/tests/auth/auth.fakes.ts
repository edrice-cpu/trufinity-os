import { jest } from '@jest/globals';
import type { AuthMailer } from '../../src/modules/auth/auth.mailer';
import type { AuthRepository, NewPasswordResetToken, NewSession, NewUser } from '../../src/modules/auth/auth.repository';
import type { AuthenticatedSession, AuthUserRecord, PublicUser } from '../../src/modules/auth/auth.types';
import type { AuthServiceOptions } from '../../src/modules/auth/auth.service';

interface StoredSession extends NewSession { id: string; revokedAt: Date | null }
interface StoredResetToken extends NewPasswordResetToken { createdAt: Date; usedAt: Date | null }

export class InMemoryAuthRepository implements AuthRepository {
  public users: AuthUserRecord[] = [];
  public sessions: StoredSession[] = [];
  public resetTokens: StoredResetToken[] = [];

  public async findUserByEmail(normalizedEmail: string): Promise<AuthUserRecord | null> {
    return this.users.find((user) => user.normalizedEmail === normalizedEmail) ?? null;
  }

  public async recordFailedLogin(userId: string, maxAttempts: number, lockoutMinutes: number): Promise<void> {
    const user = this.mustFind(userId);
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= maxAttempts) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000);
    }
  }

  public async recordSuccessfulLogin(userId: string): Promise<void> {
    const user = this.mustFind(userId);
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }

  public async createSession(session: NewSession): Promise<string> {
    const id = `session-${this.sessions.length + 1}`;
    this.sessions.push({ ...session, id, revokedAt: null });
    return id;
  }

  public async findActiveSession(tokenHash: string): Promise<AuthenticatedSession | null> {
    const session = this.sessions.find((s) => s.tokenHash === tokenHash && !s.revokedAt && s.expiresAt > new Date());
    const user = session && this.users.find((u) => u.id === session.userId && u.isActive);
    return session && user ? { sessionId: session.id, user: { id: user.id, email: user.email, fullName: user.fullName } } : null;
  }

  public async revokeSession(tokenHash: string): Promise<void> {
    for (const session of this.sessions) if (session.tokenHash === tokenHash) session.revokedAt ??= new Date();
  }

  public async countResetRequestsSince(userId: string, since: Date): Promise<number> {
    return this.resetTokens.filter((t) => t.userId === userId && t.createdAt >= since).length;
  }

  public async createPasswordResetToken(token: NewPasswordResetToken): Promise<void> {
    for (const existing of this.resetTokens) if (existing.userId === token.userId) existing.usedAt ??= new Date();
    this.resetTokens.push({ ...token, createdAt: new Date(), usedAt: null });
  }

  public async resetPasswordWithToken(tokenHash: string, passwordHash: string): Promise<PublicUser | null> {
    const token = this.resetTokens.find((t) => t.tokenHash === tokenHash && !t.usedAt && t.expiresAt > new Date());
    const user = token && this.users.find((u) => u.id === token.userId && u.isActive);
    if (!token || !user) return null;
    for (const t of this.resetTokens) if (t.userId === user.id) t.usedAt ??= new Date();
    for (const s of this.sessions) if (s.userId === user.id) s.revokedAt ??= new Date();
    user.passwordHash = passwordHash;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    return { id: user.id, email: user.email, fullName: user.fullName };
  }

  public async createUser(user: NewUser): Promise<PublicUser> {
    const id = `user-${this.users.length + 1}`;
    this.users.push({ ...user, id, isActive: true, failedLoginAttempts: 0, lockedUntil: null });
    return { id, email: user.email, fullName: user.fullName };
  }

  private mustFind(userId: string): AuthUserRecord {
    const user = this.users.find((u) => u.id === userId);
    if (!user) throw new Error(`Unknown user ${userId}`);
    return user;
  }
}

export const createFakeMailer = () => ({
  sendPasswordResetEmail: jest.fn<AuthMailer['sendPasswordResetEmail']>().mockResolvedValue(undefined),
  sendPasswordChangedEmail: jest.fn<AuthMailer['sendPasswordChangedEmail']>().mockResolvedValue(undefined),
});

export const testOptions: AuthServiceOptions = {
  sessionTtlHours: 12,
  passwordResetTtlMinutes: 30,
  maxFailedLogins: 3,
  lockoutMinutes: 15,
  appBaseUrl: 'https://app.example.test',
};

export const extractResetToken = (resetUrl: string): string => {
  const token = new URL(resetUrl).hash.replace(/^#token=/, '');
  if (!token) throw new Error('Reset URL has no token fragment');
  return token;
};
