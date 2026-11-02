// Matrix row 13: PIN format, salted hashing, verification.
import { describe, expect, it } from 'vitest';
import { PIN_RULES, hashPin, validatePin, verifyPin } from '../src/auth/pin.js';

describe('validatePin', () => {
  it('accepts exactly four ASCII digits', () => {
    expect(validatePin('0000')).toEqual({ ok: true });
    expect(validatePin('1234')).toEqual({ ok: true });
  });

  it('rejects anything else', () => {
    for (const bad of ['123', '12345', '12a4', ' 1234', '1234 ', '١٢٣٤', '', '12.4']) {
      expect(validatePin(bad)).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('rules: length 4, five attempts, 15-minute lock', () => {
    expect(PIN_RULES).toEqual({ length: 4, maxFailedAttempts: 5, lockoutMs: 15 * 60 * 1000 });
  });
});

describe('hashPin / verifyPin', () => {
  it('verifies the right PIN and refuses a wrong one', async () => {
    const hash = await hashPin('1234');
    expect(await verifyPin('1234', hash)).toBe(true);
    expect(await verifyPin('1235', hash)).toBe(false);
  });

  it('uses a fresh salt every time, so equal PINs give different hashes', async () => {
    expect(await hashPin('1234')).not.toBe(await hashPin('1234'));
  });

  it('uses the scrypt$<salt>$<key> format with base64url parts of the expected sizes (16-byte salt, 32-byte key)', async () => {
    const hash = await hashPin('9876');
    const parts = hash.split('$');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a malformed stored hash instead of matching', async () => {
    expect(await verifyPin('1234', 'not-a-hash')).toBe(false);
    expect(await verifyPin('1234', '')).toBe(false);
  });
});
