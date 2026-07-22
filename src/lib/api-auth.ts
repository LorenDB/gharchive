import { NextRequest, NextResponse } from 'next/server';
import {
  getCurrentUser,
  isOidcConfigured,
  type SessionUser,
} from '@/lib/auth';
import { AUTOLOGIN_USER_ID, runAsUserAsync } from '@/lib/user-context';
import { createHash } from 'crypto';

const AUTOLOGIN_USER: SessionUser = {
  id: AUTOLOGIN_USER_ID,
  username: 'admin',
  email: null,
  name: 'Admin (autologin)',
  role: 'admin',
  groups: [],
};

// ── In-memory rate limiter ──────────────────────────────────────

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

function rateLimitKey(req: NextRequest, limit: { windowMs: number }): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  return `ratelimit\0${ip}\0${req.nextUrl.pathname}`;
}

export function checkRateLimit(
  req: NextRequest,
  opts: { maxRequests?: number; windowMs?: number } = {}
): NextResponse | null {
  const maxRequests = opts.maxRequests ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const key = rateLimitKey(req, { windowMs });
  const now = Date.now();

  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  bucket.count++;
  if (bucket.count > maxRequests) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)) } }
    );
  }
  return null;
}

// Clean up expired buckets periodically
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitBuckets) {
      if (now >= v.resetAt) rateLimitBuckets.delete(k);
    }
  }, 60_000).unref?.();
}

// ── CSRF protection ─────────────────────────────────────────────

const CSRF_SENSITIVE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function checkCsrf(req: NextRequest): NextResponse | null {
  if (!CSRF_SENSITIVE_METHODS.includes(req.method)) return null;

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host') || '';
  const xForwardedHost = req.headers.get('x-forwarded-host') || '';

  const appOrigin = (
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    ''
  ).replace(/\/$/, '');

  if (appOrigin) {
    try {
      const appHost = new URL(appOrigin).host;
      for (const header of [origin, referer]) {
        if (!header) continue;
        try {
          const headerHost = new URL(header).host;
          if (headerHost === appHost || headerHost === host || headerHost === xForwardedHost) {
            return null;
          }
        } catch {}
      }
      // If APP_URL is set and neither origin nor referer match, reject
      if (origin || referer) {
        return NextResponse.json(
          { error: 'CSRF check failed' },
          { status: 403 }
        );
      }
    } catch {}
  }

  // No configured APP_URL — rely on sameSite cookies only
  return null;
}
// ── User resolution ─────────────────────────────────────────────

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

