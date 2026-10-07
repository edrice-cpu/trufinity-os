import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// OWASP Password Storage Cheat Sheet: scrypt with N=2^17, r=8, p=1.
const SCRYPT_LOG_N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const HASH_PREFIX = 'scrypt';

const deriveKey = (password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

/** Hashes a password as `scrypt$logN$r$p$salt$hash` so parameters can be raised later without breaking old hashes. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, {
    N: 2 ** SCRYPT_LOG_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY,
  });
  return [HASH_PREFIX, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
};

export const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
  const [, logN, r, p, saltBase64, keyBase64] = parts;
  const parsedLogN = Number(logN);
  const parsedR = Number(r);
  const parsedP = Number(p);
  if (![parsedLogN, parsedR, parsedP].every((value) => Number.isInteger(value) && value > 0) || parsedLogN > 20) {
    return false;
  }

  const expected = Buffer.from(keyBase64 ?? '', 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await deriveKey(password, Buffer.from(saltBase64 ?? '', 'base64'), {
    N: 2 ** parsedLogN, r: parsedR, p: parsedP, maxmem: SCRYPT_MAX_MEMORY,
  });
  return timingSafeEqual(actual, expected);
};

let dummyHash: Promise<string> | undefined;

/** Burns the same hashing cost as a real check so unknown emails cannot be detected by response time. */
export const verifyAgainstDummyHash = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
  await verifyPassword(password, await dummyHash);
};

/** 256-bit URL-safe random token for sessions and password resets. */
export const generateToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are high-entropy, so a fast unsalted SHA-256 is sufficient for storage lookup. */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
