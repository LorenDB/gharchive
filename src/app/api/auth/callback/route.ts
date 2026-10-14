import { NextRequest, NextResponse } from 'next/server';
import {
  appUrl,
  claimsToUsername,
  decodeJwtPayload,
  exchangeCode,
  fetchOidcMetadata,
  fetchUserInfo,
  getOidcConfig,
  getAdminGroup,
  isOidcConfigured,
  mergeOidcClaims,
  type OidcClaims,
} from '@/lib/oidc';
import {
  clearCookieOptions,
  createSessionToken,
  OAUTH_COOKIE,
  readOAuthStateToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionUser,
} from '@/lib/session';
import { ensureAppUser } from '@/lib/db';

/** Same-origin relative path only (no protocol-relative or scheme smuggling). */
function safeReturnTo(path: string | null | undefined): string {
  if (!path || typeof path !== 'string') return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return '/';
  }
  if (/[\0\r\n\\]/.test(path)) return '/';
  // Reject any path that starts with a protocol scheme after the leading /
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.slice(1))) return '/';
  if (path.length > 512) return '/';
  // Normalize to prevent open redirect via path traversal (/foo/../../evil.com)
  try {
    const normalized = new URL(path, 'http://localhost').pathname;
    if (!normalized.startsWith('/') || normalized.startsWith('//')) return '/';
    return normalized;
  } catch {
    return '/';
  }
}

/** User-facing error only — never leak token exchange / internal details. */
function redirectLoginError(message: string, logDetail?: unknown) {
  if (logDetail !== undefined) {
    console.error('[auth/callback]', message, logDetail);
  } else {
    console.error('[auth/callback]', message);
  }
  const url = new URL(appUrl('/login'));
  // Cap and sanitize so IdP error_description cannot inject into UI/logs loosely
  const safe =
    typeof message === 'string' && message.length > 0
      ? message.replace(/[\r\n]/g, ' ').slice(0, 200)
      : 'Authentication failed';
  url.searchParams.set('error', safe);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
  return res;
}

export async function GET(req: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.redirect(appUrl('/'));
  }

  // Basic rate limit on the callback (token exchange does outbound fetch).
  const { checkRateLimit } = await import('@/lib/api-auth');
  const limited = checkRateLimit(req, { maxRequests: 30, windowMs: 60_000 });
  if (limited) {
    return redirectLoginError('Too many requests. Please try again.');
  }

  const config = getOidcConfig();
  if (!config) {
    return redirectLoginError('OIDC is not configured');
  }

  const error = req.nextUrl.searchParams.get('error');
  if (error) {
    // Prefer stable short codes; do not echo full IdP error_description (info leak)
    const desc = req.nextUrl.searchParams.get('error_description');
    if (desc) console.error('[auth/callback] IdP error:', error, desc.slice(0, 300));
    return redirectLoginError(
      error === 'access_denied' ? 'Access denied' : 'Sign-in was cancelled or failed'
    );
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) {
    return redirectLoginError('Missing authorization code or state');
  }

  const oauthCookie = req.cookies.get(OAUTH_COOKIE)?.value;
  const oauth = await readOAuthStateToken(oauthCookie);
  if (!oauth || !timingSafeEqual(oauth.state, state)) {
    return redirectLoginError('Invalid or expired OAuth state');
  }

  try {
    const meta = await fetchOidcMetadata(config.issuer);
    const tokens = await exchangeCode({
      meta,
      config,
      code,
      codeVerifier: oauth.codeVerifier,
    });

    // Always validate id_token when present (OIDC Core §3.1.3.7 nonce check).
    // Profile claims often live only on the id_token; userinfo may be sparse
    // (sub-only). Merge both so neither source alone can drop the other.
    // id_token is REQUIRED — never trust userinfo alone for sub/groups.
    if (!tokens.id_token) {
      return redirectLoginError('Invalid id_token from OIDC provider');
    }
    const idClaims: OidcClaims | null = decodeJwtPayload(tokens.id_token, {
      expectedIssuer: config.issuer,
      expectedClientId: config.clientId,
      expectedNonce: oauth.nonce,
    });
    if (!idClaims?.sub) {
      return redirectLoginError('Invalid id_token from OIDC provider');
    }

    let userInfoClaims: OidcClaims | null = null;
    if (meta.userinfo_endpoint && tokens.access_token) {
      try {
        userInfoClaims = await fetchUserInfo(meta, tokens.access_token);
      } catch (e) {
        console.warn('[auth/callback] userinfo failed, using id_token claims', e);
      }
    }

    // Reject if userinfo disagrees on subject — possible token confusion.
    if (
      userInfoClaims?.sub &&
      idClaims.sub &&
      userInfoClaims.sub !== idClaims.sub
    ) {
      console.error('[auth/callback] sub mismatch between id_token and userinfo');
      return redirectLoginError('Invalid id_token from OIDC provider');
    }

    // Prefer id_token as base (nonce-validated); userinfo overlays non-empty fields.
    const claims = mergeOidcClaims(idClaims, userInfoClaims);
    if (!claims?.sub) {
      return redirectLoginError(
        'Could not determine user identity from OIDC provider'
      );
    }

    const rawGroups = claims?.groups ?? [];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === 'string').slice(0, 100)
      : [];
    const adminGroup = getAdminGroup();
    // Require explicit OIDC_ADMIN_GROUP membership for admin — never default
    // every SSO user to admin (privilege escalation in multi-user deploys).
    const isAdmin = Boolean(adminGroup && groups.includes(adminGroup));
    if (!adminGroup) {
      console.warn(
        '[auth/callback] OIDC_ADMIN_GROUP is not set; all users get role=user. ' +
          'Set OIDC_ADMIN_GROUP to grant admin via IdP group membership.'
      );
    }

    const user: SessionUser = {
      id: claims.sub,
      username: claimsToUsername(claims).slice(0, 128),
      email:
        typeof claims.email === 'string' ? claims.email.slice(0, 320) : null,
      name: typeof claims.name === 'string' ? claims.name.slice(0, 256) : null,
      role: isAdmin ? 'admin' : 'user',
      groups,
    };

    // Register user; only admins claim legacy no-auth data (prevents the first
    // arbitrary SSO user from inheriting the autologin PAT/repos).
    const { claimed_legacy } = ensureAppUser(user, { allowLegacyClaim: isAdmin });
    if (claimed_legacy) {
      console.log(
        `[auth] first SSO user ${user.username} (${user.id}) claimed legacy autologin data`
      );
    }

    const sessionToken = await createSessionToken(user);
    const res = NextResponse.redirect(
      appUrl(safeReturnTo(oauth.returnTo))
    );
    res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
    res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'OIDC callback failed';
    return redirectLoginError('Sign-in failed. Please try again.', message);
  }
}

/** Constant-time state comparison to avoid leaking prefix via timing. */
function timingSafeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
