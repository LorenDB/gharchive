import { NextRequest, NextResponse } from 'next/server';
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

// ── In-memory rate limiter ──────────────────────────────────────

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

function clientIp(req: NextRequest): string {
  // Prefer right-most / last proxy hop only when a trusted proxy sets these.
  // Take the first XFF entry (client as seen by the edge proxy).
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

function rateLimitKey(req: NextRequest): string {
  return `ratelimit\0${clientIp(req)}\0${req.nextUrl.pathname}`;
}

export function checkRateLimit(
  req: NextRequest,
  opts: { maxRequests?: number; windowMs?: number } = {}
): NextResponse | null {
  const maxRequests = opts.maxRequests ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const key = rateLimitKey(req);
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
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)),
        },
      }
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

function configuredAppOrigin(): string {
  return (
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    ''
  ).replace(/\/$/, '');
}

function hostFromUrlHeader(header: string): string | null {
  try {
    return new URL(header).host;
  } catch {
    return null;
  }
}

/**
 * Origin/Referer check for cookie-authenticated mutating requests.
 *
 * Only trusts the configured APP_URL host — never Host / X-Forwarded-Host
 * from the request (those are attacker-controlled without a trusted proxy).
 * When APP_URL is set, Origin or Referer is required and must match.
 */
export function checkCsrf(req: NextRequest): NextResponse | null {
  if (!CSRF_SENSITIVE_METHODS.includes(req.method)) return null;

  const appOrigin = configuredAppOrigin();
  if (!appOrigin) {
    // No configured origin — rely on SameSite=Lax cookies only (dev / misconfig)
    return null;
  }

  let appHost: string;
  try {
    appHost = new URL(appOrigin).host;
  } catch {
    return null;
  }

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  if (!origin && !referer) {
    return NextResponse.json(
      { error: 'CSRF check failed: missing Origin/Referer' },
      { status: 403 }
    );
  }

  for (const header of [origin, referer]) {
    if (!header) continue;
    const headerHost = hostFromUrlHeader(header);
    if (headerHost && headerHost === appHost) {
      return null;
    }
  }

  return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
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

