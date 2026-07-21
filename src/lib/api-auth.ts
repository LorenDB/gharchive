import { NextResponse } from 'next/server';
import {
  getCurrentUser,
  isOidcConfigured,
  type SessionUser,
} from '@/lib/auth';
import { AUTOLOGIN_USER_ID, enterUserContext } from '@/lib/user-context';

/**
 * Call at the start of protected API handlers.
 * - 401 when SSO is on and unauthenticated
 * - Binds AsyncLocalStorage user context for multi-tenant db access
 */
export async function ensureApiAuth(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) {
    if (isOidcConfigured()) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    enterUserContext(AUTOLOGIN_USER_ID);
    return null;
  }
  enterUserContext(user.id);
  return null;
}

/** Like ensureApiAuth but also returns the session user. */
export async function requireApiUser(): Promise<
  { user: SessionUser; error?: undefined } | { user?: undefined; error: NextResponse }
> {
  const denied = await ensureApiAuth();
  if (denied) return { error: denied };
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      ),
    };
  }
  enterUserContext(user.id);
  return { user };
}
