// Origin allowlist (plan 2.2): one host serves static, API and WebSocket; everything else is refused.
import type { BeforeUpgradeHandler } from 'colyseus';

/** Methods that change state and therefore must carry an allowed Origin. */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Exact-match comparison of an Origin header value against the allowlist (scheme + host + port). */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

/**
 * Decide whether an HTTP request may proceed: GET/HEAD/OPTIONS pass (a plain navigation carries no Origin);
 * state-changing methods and WebSocket upgrades must present an allowed Origin.
 */
export function originAllowsRequest(
  method: string,
  origin: string | undefined,
  allowed: readonly string[],
  isWebSocketUpgrade: boolean,
): boolean {
  const needsOrigin = isWebSocketUpgrade || STATE_CHANGING_METHODS.has(method.toUpperCase());
  return !needsOrigin || isAllowedOrigin(origin, allowed);
}

/**
 * The guard for the Colyseus transport's `beforeUpgrade`: a WebSocket upgrade without an allowed Origin gets
 * a 403 Response instead of a connection (browsers always send Origin on an upgrade).
 */
export function createUpgradeGuard(allowed: readonly string[]): BeforeUpgradeHandler {
  return (_request, context) =>
    isAllowedOrigin(context.headers.get('origin') ?? undefined, allowed)
      ? undefined
      : new Response('Forbidden: origin not allowed', { status: 403 });
}
