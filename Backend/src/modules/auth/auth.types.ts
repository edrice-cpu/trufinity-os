import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const emailSchema = z.string().trim().max(320).pipe(z.email());
const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const loginSchema = z.object({
  email: emailSchema,
  // Login accepts any length up to the maximum so policy changes never lock out existing users.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid reset token.'),
  password: passwordSchema,
});

export const newPasswordSchema = passwordSchema;

export interface AuthUserRecord {
  id: string;
  email: string;
  normalizedEmail: string;
  fullName: string | null;
  passwordHash: string;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string | null;
}

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface SessionResult {
  token: string;
  expiresAt: Date;
  user: PublicUser;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: PublicUser;
}

export const toPublicUser = (user: Pick<AuthUserRecord, 'id' | 'email' | 'fullName'>): PublicUser => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
});
