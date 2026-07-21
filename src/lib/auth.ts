/**
 * App authentication.
 *
 * - When OIDC env is configured: real SSO sessions (see /api/auth/*).
 * - When not: autologin as a local admin (dev / single-user Docker), with a
 *   UI warning banner (AuthWarningBanner).
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { isOidcConfigured } from '@/lib/oidc';
import {
  readSessionToken,
  SESSION_COOKIE,
  type SessionUser,
} from '@/lib/session';
import { AUTOLOGIN_USER_ID } from '@/lib/user-context';

export type { SessionUser };

const AUTOLOGIN_USER: SessionUser = {
  id: AUTOLOGIN_USER_ID,
  username: 'admin',
  email: null,
  name: 'Admin (autologin)',
  role: 'admin',
};

export { isOidcConfigured };

/** True when the app is running without SSO (open autologin). */
export function isAutologinMode(): boolean {
  return !isOidcConfigured();
}

/**
 * Current user for server components / route handlers.
 * Autologin mode always returns the local admin.
 * OIDC mode returns null when unauthenticated.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  if (isAutologinMode()) {
    return AUTOLOGIN_USER;
  }

  // Next 14: cookies() is sync; still wrapped async for session crypto.
  const jar = cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);
  return session?.user ?? null;
}

/** Stable user id for the current actor (or null if SSO and logged out). */
export async function getCurrentUserId(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.id ?? null;
}

/**
 * Require an authenticated admin. In autologin mode this always succeeds.
 * Throws / returns a Response-friendly error for API handlers.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError('Authentication required', 401);
  }
  if (user.role !== 'admin') {
    throw new AuthError('Admin access required', 403);
  }
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Wrap API handlers: return JSON 401/403 on AuthError. */
export function authErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

/** Public shape for /api/auth/me and client UI. */
export function publicUser(user: SessionUser | null) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export function authStatus() {
  return {
    mode: isOidcConfigured() ? ('oidc' as const) : ('autologin' as const),
    oidc_configured: isOidcConfigured(),
    autologin: isAutologinMode(),
  };
}
