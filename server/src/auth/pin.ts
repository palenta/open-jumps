// PIN rules (plan 1.5, 2.3): exactly four digits, stored only as a salted scrypt hash, brute force limited.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const PIN_RULES = {
  length: 4,
  /** Failed logins before the account locks. */
  maxFailedAttempts: 5,
  /** How long a lock lasts. */
  lockoutMs: 15 * 60 * 1000,
} as const;

export type PinCheck = { ok: true } | { ok: false; reason: 'format' };

const PIN_PATTERN = /^[0-9]{4}$/;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Exactly four ASCII digits, nothing else. */
export function validatePin(pin: string): PinCheck {
  return PIN_PATTERN.test(pin) ? { ok: true } : { ok: false, reason: 'format' };
}

function deriveKey(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_BYTES, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Salted scrypt hash, encoded as `scrypt$<salt>$<hash>`; a fresh random salt every call. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(pin, salt);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time comparison against a hash produced by hashPin. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  const [scheme, saltPart, keyPart, ...rest] = hash.split('$');
  if (scheme !== 'scrypt' || saltPart === undefined || keyPart === undefined || rest.length > 0) return false;
  const salt = Buffer.from(saltPart, 'base64url');
  const expected = Buffer.from(keyPart, 'base64url');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = await deriveKey(pin, salt);
  return timingSafeEqual(actual, expected);
}
