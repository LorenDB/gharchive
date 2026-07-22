import { NextRequest, NextResponse } from 'next/server';
import {
  appUrl,
  buildAuthorizationUrl,
  fetchOidcMetadata,
  getOidcConfig,
  isOidcConfigured,
} from '@/lib/oidc';
import {
  createOAuthStateToken,
  OAUTH_COOKIE,
  OAUTH_MAX_AGE_SEC,
  pkceChallenge,
  randomUrlSafe,
  sessionCookieOptions,
} from '@/lib/session';

/** Same-origin relative path only (no protocol-relative or scheme smuggling). */
function safeReturnTo(path: string | null): string {
  if (!path || typeof path !== 'string') return '/';
  // Must be a single relative path: /foo, not //evil, /\\evil, http:…
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return '/';
  }
  if (/[\0\t\r\n\\]/.test(path)) return '/';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.slice(1))) return '/';
  // Cap length; strip query fragments that try open-redirect tricks
  if (path.length > 512) return '/';
  return path;
}

export async function GET(req: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.redirect(appUrl('/'));
  }

  const config = getOidcConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'OIDC is not configured' },
      { status: 500 }
    );
  }

  try {
    const meta = await fetchOidcMetadata(config.issuer);
    const state = randomUrlSafe(16);
    const codeVerifier = randomUrlSafe(32);
    const codeChallenge = await pkceChallenge(codeVerifier);
    const nonce = randomUrlSafe(16);
    const returnTo = safeReturnTo(req.nextUrl.searchParams.get('next'));

    const oauthToken = await createOAuthStateToken(
      state,
      codeVerifier,
      nonce,
      returnTo
    );

    const authUrl = buildAuthorizationUrl({
      meta,
      config,
      state,
      codeChallenge,
      nonce,
    });

    const res = NextResponse.redirect(authUrl);
    res.cookies.set(OAUTH_COOKIE, oauthToken, sessionCookieOptions(OAUTH_MAX_AGE_SEC));
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'OIDC login failed';
    console.error('[auth/login]', message);
    const loginUrl = new URL(appUrl('/login'));
    loginUrl.searchParams.set('error', 'Authentication failed');
    return NextResponse.redirect(loginUrl.toString());
  }
}
