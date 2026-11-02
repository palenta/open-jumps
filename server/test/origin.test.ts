// Matrix rows 2 and 20: the Origin allowlist for state-changing requests and WebSocket upgrades.
import { describe, expect, it } from 'vitest';
import { STATE_CHANGING_METHODS, createUpgradeGuard, isAllowedOrigin, originAllowsRequest } from '../src/http/origin.js';

const ALLOWED = ['https://play.open-jumps.test'];

describe('isAllowedOrigin', () => {
  it('matches scheme, host and port exactly', () => {
    expect(isAllowedOrigin('https://play.open-jumps.test', ALLOWED)).toBe(true);
    expect(isAllowedOrigin('http://play.open-jumps.test', ALLOWED)).toBe(false);
    expect(isAllowedOrigin('https://play.open-jumps.test:444', ALLOWED)).toBe(false);
    expect(isAllowedOrigin('https://evil.open-jumps.test', ALLOWED)).toBe(false);
    expect(isAllowedOrigin('https://play.open-jumps.test.evil.com', ALLOWED)).toBe(false);
    expect(isAllowedOrigin(undefined, ALLOWED)).toBe(false);
    expect(isAllowedOrigin('null', ALLOWED)).toBe(false);
  });
});

describe('originAllowsRequest', () => {
  it('GET/HEAD/OPTIONS pass without an Origin (plain navigations carry none)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(originAllowsRequest(method, undefined, ALLOWED, false)).toBe(true);
  });

  it('state-changing methods need an allowed Origin', () => {
    for (const method of STATE_CHANGING_METHODS) {
      expect(originAllowsRequest(method, undefined, ALLOWED, false)).toBe(false);
      expect(originAllowsRequest(method, 'https://evil.example', ALLOWED, false)).toBe(false);
      expect(originAllowsRequest(method, ALLOWED[0], ALLOWED, false)).toBe(true);
    }
  });

  it('a WebSocket upgrade needs an allowed Origin even though it is a GET', () => {
    expect(originAllowsRequest('GET', undefined, ALLOWED, true)).toBe(false);
    expect(originAllowsRequest('GET', 'https://evil.example', ALLOWED, true)).toBe(false);
    expect(originAllowsRequest('GET', ALLOWED[0], ALLOWED, true)).toBe(true);
  });
});

describe('createUpgradeGuard (Colyseus beforeUpgrade)', () => {
  // The guard is built inside each test, so both scenarios register and run even if the factory throws.
  const context = (origin?: string) => ({
    ip: '127.0.0.1',
    headers: new Headers(origin ? { origin } : {}),
  });

  it('lets an allowed Origin upgrade (returns nothing)', async () => {
    const guard = createUpgradeGuard(ALLOWED);
    const request = new Request('https://play.open-jumps.test/ws', { headers: { origin: ALLOWED[0]! } });
    expect(await guard(request, context(ALLOWED[0]))).toBeUndefined();
  });

  it('answers 403 instead of upgrading for a foreign or missing Origin', async () => {
    const guard = createUpgradeGuard(ALLOWED);
    const foreign = await guard(new Request('https://play.open-jumps.test/ws'), context('https://evil.example'));
    expect(foreign).toBeInstanceOf(Response);
    expect((foreign as Response).status).toBe(403);
    const missing = await guard(new Request('https://play.open-jumps.test/ws'), context(undefined));
    expect((missing as Response).status).toBe(403);
  });
});
