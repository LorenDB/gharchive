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
const MAX_RATE_LIMIT_BUCKETS = 10_000;

function clientIp(req: NextRequest): string {
  // X-Forwarded-For / X-Real-IP are only trusted when TRUST_PROXY is set
  // (deployment behind a reverse proxy that strips client-supplied values).
  // Without that, attackers can rotate spoofed XFF values to bypass rate limits.
  const trustProxy =
    process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';
  if (trustProxy) {
    const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    // Validate as IP/host token to bound map growth from spoofed values.
    if (xff && xff.length <= 64 && /^[a-zA-Z0-9.:_-]+$/.test(xff)) return xff;
    const realIp = req.headers.get('x-real-ip')?.trim();
    if (realIp && realIp.length <= 64 && /^[a-zA-Z0-9.:_-]+$/.test(realIp)) return realIp;
  }
  return 'unknown';
}

function rateLimitKey(req: NextRequest): string {
  // Prefer per-user scoping when a session exists so one aggressive client
  // behind NAT (all sharing `unknown`) can't eat everyone's quota — and so
  // per-IP collapse without TRUST_PROXY doesn't become a global DoS bucket.
  // We can't await the session here (sync); instead callers that know the user
  // can pass a user-scoped key via checkRateLimitForUser. The pathname keeps
  // buckets separated per endpoint.
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

  // Bound map growth (XFF rotation / path enumeration) — evict expired first,
  // then drop the oldest entry if still over capacity.
  if (!rateLimitBuckets.has(key) && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    for (const [k, v] of rateLimitBuckets) {
      if (now >= v.resetAt) rateLimitBuckets.delete(k);
      if (rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS) break;
    }
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      const oldest = rateLimitBuckets.keys().next().value;
      if (oldest !== undefined) rateLimitBuckets.delete(oldest);
    }
  }

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
    const u = new URL(header);
    // Include scheme + port: http://app vs https://app must not be conflated.
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Origin/Referer check for cookie-authenticated mutating requests.
 *
 * Only trusts the configured APP_URL origin — never Host / X-Forwarded-Host
 * from the request (those are attacker-controlled without a trusted proxy).
 * When APP_URL is set, Origin or Referer is required and must match
 * scheme + host + port. When APP_URL is unset but OIDC is configured, fail
 * closed (misconfiguration would otherwise leave mutating routes CSRF-open).
 */
export function checkCsrf(req: NextRequest): NextResponse | null {
  if (!CSRF_SENSITIVE_METHODS.includes(req.method)) return null;

  const appOrigin = configuredAppOrigin();
  if (!appOrigin) {
    // Fail closed when SSO is on (auth cookies are valuable); otherwise rely
    // on SameSite=Lax only (dev / single-user autologin with no cookies).
    try {
      if (isOidcConfigured()) {
        return NextResponse.json(
          { error: 'CSRF check failed: APP_URL is not configured' },
          { status: 403 }
        );
      }
    } catch {
      // ignore — fall through to Lax-only
    }
    return null;
  }

  let appOriginNormalized: string;
  try {
    const u = new URL(appOrigin);
    appOriginNormalized = `${u.protocol}//${u.host}`;
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

  // If Origin is present (fetch/XHR/form with Origin), it must match —
  // an attacker Origin + victim Referer must not pass.
  if (origin) {
    const originNormalized = hostFromUrlHeader(origin);
    if (originNormalized !== appOriginNormalized) {
      return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
    }
    return null;
  }
  // Origin absent (some same-origin form posts / navigations): Referer must match.
  const refererNormalized = referer ? hostFromUrlHeader(referer) : null;
  if (refererNormalized === appOriginNormalized) return null;

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

