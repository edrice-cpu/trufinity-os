import { describe, expect, it, jest } from '@jest/globals';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../../src/modules/auth/auth.crypto';

// Real scrypt hashing (OWASP cost) takes ~0.5s per hash, well past Jest's 5s default under parallel load.
jest.setTimeout(60_000);

describe('Auth crypto', () => {
  it('hashes passwords with a per-hash salt and verifies them', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password here', first)).resolves.toBe(false);
  });

  it('rejects malformed or tampered hashes without throwing', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', hash.replace('scrypt$17', 'scrypt$30'))).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', `${hash.slice(0, -8)}AAAAAAA=`)).resolves.toBe(false);
  });

  it('generates 256-bit URL-safe tokens and stores only their SHA-256 hash', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});
