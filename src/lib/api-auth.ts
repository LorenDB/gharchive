import { NextResponse } from 'next/server';
import {
  getCurrentUser,
  isOidcConfigured,
  type SessionUser,
} from '@/lib/auth';
import { AUTOLOGIN_USER_ID, runAsUserAsync } from '@/lib/user-context';

const AUTOLOGIN_USER: SessionUser = {
  id: AUTOLOGIN_USER_ID,
  username: 'admin',
  email: null,
  name: 'Admin (autologin)',
  role: 'admin',
  groups: [],
};

/**
 * Resolve the current user (SSO session or autologin).
 * Returns a 401 Response when SSO is required and missing.
 */
export async function resolveApiUser(): Promise<
  { user: SessionUser } | { error: NextResponse }
> {
  const user = await getCurrentUser();
  if (user) return { user };
  if (isOidcConfigured()) {
    return {
      error: NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      ),
    };
  }
  return { user: AUTOLOGIN_USER };
}

/**
 * Run an API handler with multi-tenant user context bound for the full
 * async lifetime of the handler (survives further awaits via als.run).
 */
export async function withApiUser(
  handler: (user: SessionUser) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  const resolved = await resolveApiUser();
  if ('error' in resolved) return resolved.error;
  const { user } = resolved;
  return runAsUserAsync(user.id, async () => handler(user));
}

