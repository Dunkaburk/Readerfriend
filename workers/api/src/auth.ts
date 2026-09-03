/**
 * Bearer-token auth (SPEC §5). One shared secret, constant-time compare.
 * That is the entire auth system.
 */

import type { Context, Next } from 'hono';
import type { Env } from './env';

/** Constant-time byte equality (lengths are equal by construction here). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Compare two tokens without leaking where they differ. Both sides are hashed
 * to a fixed 32-byte digest first, so the comparison length never depends on
 * the input length.
 */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return bytesEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Hono middleware guarding every /api route except /api/health. */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  if (c.req.path === '/api/health') return next();
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing bearer token' }, 401);
  }
  const ok = await tokenMatches(header.slice(7).trim(), c.env.APP_TOKEN);
  if (!ok) return c.json({ error: 'Invalid token' }, 401);
  return next();
}
