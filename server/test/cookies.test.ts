// Matrix row 2 (server side): the cookie attributes Safari needs, and parsing of the Cookie header.
import { describe, expect, it } from 'vitest';
import { clearSessionCookie, parseCookies, sessionCookie } from '../src/auth/cookies.js';

describe('sessionCookie', () => {
  it('sets Path=/, HttpOnly, Secure, SameSite=Lax and a one-year Max-Age', () => {
    const cookie = sessionCookie('tok123', { secure: true, maxAgeSec: 31_536_000 });
    expect(cookie.startsWith('oj_session=tok123;')).toBe(true);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=31536000']) {
      expect(cookie).toContain(attr);
    }
  });

  it('omits Secure only when explicitly asked (plain-http development)', () => {
    expect(sessionCookie('t', { secure: false, maxAgeSec: 10 })).not.toContain('Secure');
    expect(sessionCookie('t', { secure: false, maxAgeSec: 10 })).toContain('HttpOnly');
  });

  it('refuses a token with characters that would break the header', () => {
    expect(() => sessionCookie('bad;token', { secure: true, maxAgeSec: 10 })).toThrow();
    expect(() => sessionCookie('bad token', { secure: true, maxAgeSec: 10 })).toThrow();
  });

  it('clearSessionCookie empties the value with Max-Age=0 and the same attributes', () => {
    const cookie = clearSessionCookie({ secure: true });
    expect(cookie.startsWith('oj_session=;')).toBe(true);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('parseCookies', () => {
  it('parses name=value pairs, first occurrence wins, malformed pairs ignored', () => {
    expect(parseCookies('a=1; oj_session=abc; a=2; junk; =x; b=')).toEqual({ a: '1', oj_session: 'abc', b: '' });
  });

  it('an absent header gives an empty object', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});
