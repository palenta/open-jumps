// Cookie serialisation (plan 2.2): Secure, HttpOnly, SameSite=Lax, Path=/, one year.
import { SESSION } from './sessions.js';

export interface CookieOptions {
  /** Omit Secure only for plain-http local development. */
  secure: boolean;
  maxAgeSec: number;
}

/** RFC 6265 cookie-octets: printable ASCII without control characters, whitespace, DQUOTE, comma, semicolon, backslash. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

function serialise(value: string, options: CookieOptions): string {
  if (!COOKIE_VALUE.test(value)) throw new Error('cookie value contains characters not allowed in a header');
  if (!Number.isInteger(options.maxAgeSec) || options.maxAgeSec < 0) throw new Error('Max-Age must be a non-negative integer');
  const parts = [`${SESSION.cookieName}=${value}`, 'Path=/', 'HttpOnly'];
  if (options.secure) parts.push('Secure');
  parts.push('SameSite=Lax', `Max-Age=${options.maxAgeSec}`);
  return parts.join('; ');
}

/** `oj_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<n>` */
export function sessionCookie(token: string, options: CookieOptions): string {
  if (token === '') throw new Error('session token is empty');
  return serialise(token, options);
}

/** The same cookie with an empty value and Max-Age=0. */
export function clearSessionCookie(options: Pick<CookieOptions, 'secure'>): string {
  return serialise('', { secure: options.secure, maxAgeSec: 0 });
}

/** Parse a Cookie request header into name → value (first occurrence wins; malformed pairs ignored). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(';') ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === '' || cookies.has(name)) continue;
    cookies.set(name, pair.slice(eq + 1).trim());
  }
  return Object.fromEntries(cookies);
}
