import type { Knex } from 'knex';
import { db } from '../../database';
import type { AuthenticatedSession, AuthUserRecord, PublicUser } from './auth.types';

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface NewPasswordResetToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  requestedIp: string | null;
}

export interface NewUser {
  email: string;
  normalizedEmail: string;
  fullName: string | null;
  passwordHash: string;
}

export interface AuthRepository {
  findUserByEmail(normalizedEmail: string): Promise<AuthUserRecord | null>;
  recordFailedLogin(userId: string, maxAttempts: number, lockoutMinutes: number): Promise<void>;
  recordSuccessfulLogin(userId: string): Promise<void>;
  createSession(session: NewSession): Promise<string>;
  findActiveSession(tokenHash: string): Promise<AuthenticatedSession | null>;
  revokeSession(tokenHash: string): Promise<void>;
  countResetRequestsSince(userId: string, since: Date): Promise<number>;
  createPasswordResetToken(token: NewPasswordResetToken): Promise<void>;
  /** Atomically consumes a valid reset token, sets the new password, clears lockout, and revokes all sessions. */
  resetPasswordWithToken(tokenHash: string, passwordHash: string): Promise<PublicUser | null>;
  createUser(user: NewUser): Promise<PublicUser>;
}

interface UserRow {
  id: string;
  email: string;
  normalized_email: string;
  full_name: string | null;
  password_hash: string;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
}

const SESSION_TOUCH_INTERVAL = "interval '5 minutes'";

export class KnexAuthRepository implements AuthRepository {
  public constructor(private readonly database: Knex = db) {}

  public async findUserByEmail(normalizedEmail: string): Promise<AuthUserRecord | null> {
    const row = await this.database<UserRow>('users').where({ normalized_email: normalizedEmail }).first();
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalized_email,
      fullName: row.full_name,
      passwordHash: row.password_hash,
      isActive: row.is_active,
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: row.locked_until,
    };
  }

  public async recordFailedLogin(userId: string, maxAttempts: number, lockoutMinutes: number): Promise<void> {
    // Single statement so concurrent failures cannot race past the lockout threshold.
    await this.database.raw(
      `UPDATE users SET
         locked_until = CASE WHEN failed_login_attempts + 1 >= :max THEN now() + make_interval(mins => :minutes) ELSE locked_until END,
         failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= :max THEN 0 ELSE failed_login_attempts + 1 END,
         updated_at = now()
       WHERE id = :userId`,
      { max: maxAttempts, minutes: lockoutMinutes, userId },
    );
  }

  public async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.database('users').where({ id: userId }).update({
      failed_login_attempts: 0,
      locked_until: null,
      last_login_at: this.database.fn.now(),
      updated_at: this.database.fn.now(),
    });
  }

  public async createSession(session: NewSession): Promise<string> {
    const [row] = await this.database('user_sessions')
      .insert({
        user_id: session.userId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt,
        ip_address: session.ipAddress,
        user_agent: session.userAgent,
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('Failed to create session.');
    return row.id;
  }

  public async findActiveSession(tokenHash: string): Promise<AuthenticatedSession | null> {
    const row = await this.database('user_sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where('s.token_hash', tokenHash)
      .whereNull('s.revoked_at')
      .where('s.expires_at', '>', this.database.fn.now())
      .where('u.is_active', true)
      .first<{ session_id: string; id: string; email: string; full_name: string | null } | undefined>(
        's.id as session_id', 'u.id', 'u.email', 'u.full_name',
      );
    if (!row) return null;

    await this.database('user_sessions')
      .where({ id: row.session_id })
      .where('last_seen_at', '<', this.database.raw(`now() - ${SESSION_TOUCH_INTERVAL}`))
      .update({ last_seen_at: this.database.fn.now() });

    return { sessionId: row.session_id, user: { id: row.id, email: row.email, fullName: row.full_name } };
  }

  public async revokeSession(tokenHash: string): Promise<void> {
    await this.database('user_sessions')
      .where({ token_hash: tokenHash })
      .whereNull('revoked_at')
      .update({ revoked_at: this.database.fn.now() });
  }

  public async countResetRequestsSince(userId: string, since: Date): Promise<number> {
    const row = await this.database('password_reset_tokens')
      .where({ user_id: userId })
      .where('created_at', '>=', since)
      .count<{ count: string }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  public async createPasswordResetToken(token: NewPasswordResetToken): Promise<void> {
    await this.database.transaction(async (trx) => {
      // Only the most recently issued link stays valid.
      await trx('password_reset_tokens')
        .where({ user_id: token.userId })
        .whereNull('used_at')
        .update({ used_at: trx.fn.now() });
      await trx('password_reset_tokens').insert({
        user_id: token.userId,
        token_hash: token.tokenHash,
        expires_at: token.expiresAt,
        requested_ip: token.requestedIp,
      });
    });
  }

  public async resetPasswordWithToken(tokenHash: string, passwordHash: string): Promise<PublicUser | null> {
    return this.database.transaction(async (trx) => {
      const tokenRow = await trx('password_reset_tokens as t')
        .join('users as u', 'u.id', 't.user_id')
        .where('t.token_hash', tokenHash)
        .whereNull('t.used_at')
        .where('t.expires_at', '>', trx.fn.now())
        .where('u.is_active', true)
        .forUpdate('t')
        .first<{ token_id: string; user_id: string; email: string; full_name: string | null } | undefined>(
          't.id as token_id', 'u.id as user_id', 'u.email', 'u.full_name',
        );
      if (!tokenRow) return null;

      await trx('password_reset_tokens')
        .where({ user_id: tokenRow.user_id })
        .whereNull('used_at')
        .update({ used_at: trx.fn.now() });
      await trx('users').where({ id: tokenRow.user_id }).update({
        password_hash: passwordHash,
        password_changed_at: trx.fn.now(),
        failed_login_attempts: 0,
        locked_until: null,
        updated_at: trx.fn.now(),
      });
      await trx('user_sessions')
        .where({ user_id: tokenRow.user_id })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now() });

      return { id: tokenRow.user_id, email: tokenRow.email, fullName: tokenRow.full_name };
    });
  }

  public async createUser(user: NewUser): Promise<PublicUser> {
    const [row] = await this.database('users')
      .insert({
        email: user.email,
        normalized_email: user.normalizedEmail,
        full_name: user.fullName,
        password_hash: user.passwordHash,
      })
      .returning<{ id: string; email: string; full_name: string | null }[]>(['id', 'email', 'full_name']);
    if (!row) throw new Error('Failed to create user.');
    return { id: row.id, email: row.email, fullName: row.full_name };
  }
}
