import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { hashPassword } from '../../src/modules/auth/auth.crypto';
import { createAuthRouter, FORGOT_PASSWORD_RESPONSE_MESSAGE } from '../../src/modules/auth/auth.routes';
import { AuthService, INVALID_CREDENTIALS_MESSAGE } from '../../src/modules/auth/auth.service';
import { createFakeMailer, extractResetToken, InMemoryAuthRepository, testOptions } from './auth.fakes';

// Real scrypt hashing (OWASP cost) takes ~0.5s per hash, well past Jest's 5s default under parallel load.
jest.setTimeout(60_000);

const PASSWORD = 'original-password-123';
let passwordHash: string;

const flushBackgroundWork = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('Auth routes', () => {
  let repository: InMemoryAuthRepository;
  let mailer: ReturnType<typeof createFakeMailer>;
  let app: express.Express;

  beforeAll(async () => { passwordHash = await hashPassword(PASSWORD); });

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    repository.users.push({
      id: 'user-1', email: 'owner@trufinity.ca', normalizedEmail: 'owner@trufinity.ca', fullName: 'Owner',
      passwordHash, isActive: true, failedLoginAttempts: 0, lockedUntil: null,
    });
    mailer = createFakeMailer();
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(new AuthService(repository, mailer, testOptions)));
  });

  it('logs in, returns a bearer token, serves /me, and logs out', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'owner@trufinity.ca', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.body).toMatchObject({ status: 'ok', user: { id: 'user-1', email: 'owner@trufinity.ca' } });
    expect(login.body).not.toHaveProperty('user.passwordHash');
    const token = login.body.token as string;

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ id: 'user-1', email: 'owner@trufinity.ca', fullName: 'Owner' });

    expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(204);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('rejects invalid credentials with a generic message and malformed input with 400', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: 'owner@trufinity.ca', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);

    const malformed = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'email' })]));
  });

  it('requires a valid bearer token for /me', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer bogus-token-value-123')).status).toBe(401);
  });

  it('returns an identical forgot-password response for known and unknown emails', async () => {
    const known = await request(app).post('/api/auth/forgot-password').send({ email: 'owner@trufinity.ca' });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@trufinity.ca' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual({ status: 'ok', message: FORGOT_PASSWORD_RESPONSE_MESSAGE });
    expect(unknown.body).toEqual(known.body);
    await flushBackgroundWork();
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('resets the password with a valid token and enforces the password policy', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: 'owner@trufinity.ca' });
    await flushBackgroundWork();
    const token = extractResetToken(mailer.sendPasswordResetEmail.mock.calls[0]![1]);

    const weak = await request(app).post('/api/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(400);

    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-password-1' });
    expect(reset.status).toBe(200);

    const reused = await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-password-2' });
    expect(reused.status).toBe(400);

    const login = await request(app).post('/api/auth/login').send({ email: 'owner@trufinity.ca', password: 'brand-new-password-1' });
    expect(login.status).toBe(200);
  });

  it('rate limits forgot-password requests per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await request(app).post('/api/auth/forgot-password').send({ email: `user${i}@trufinity.ca` })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
  });
});
