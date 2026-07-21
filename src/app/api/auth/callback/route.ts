import { NextRequest, NextResponse } from 'next/server';
import {
  claimsToUsername,
  decodeJwtPayload,
  exchangeCode,
  fetchOidcMetadata,
  fetchUserInfo,
  getOidcConfig,
  isOidcConfigured,
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

function safeReturnTo(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}

function redirectLoginError(req: NextRequest, message: string) {
  const url = new URL('/login', req.url);
  url.searchParams.set('error', message);
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
  return res;
}

export async function GET(req: NextRequest) {
  if (!isOidcConfigured()) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  const config = getOidcConfig();
  if (!config) {
    return redirectLoginError(req, 'OIDC is not configured');
  }

  const error = req.nextUrl.searchParams.get('error');
  if (error) {
    const desc =
      req.nextUrl.searchParams.get('error_description') || error;
    return redirectLoginError(req, desc);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) {
    return redirectLoginError(req, 'Missing authorization code or state');
  }

  const oauthCookie = req.cookies.get(OAUTH_COOKIE)?.value;
  const oauth = await readOAuthStateToken(oauthCookie);
  if (!oauth || oauth.state !== state) {
    return redirectLoginError(req, 'Invalid or expired OAuth state');
  }

  try {
    const meta = await fetchOidcMetadata(config.issuer);
    const tokens = await exchangeCode({
      meta,
      config,
      code,
      codeVerifier: oauth.codeVerifier,
    });

    let claims: OidcClaims | null = null;
    if (meta.userinfo_endpoint && tokens.access_token) {
      try {
        claims = await fetchUserInfo(meta, tokens.access_token);
      } catch (e) {
        console.warn('[auth/callback] userinfo failed, falling back to id_token', e);
      }
    }
    if (!claims && tokens.id_token) {
      claims = decodeJwtPayload(tokens.id_token);
    }
    if (!claims?.sub) {
      return redirectLoginError(
        req,
        'Could not determine user identity from OIDC provider'
      );
    }

    const user: SessionUser = {
      id: claims.sub,
      username: claimsToUsername(claims),
      email: claims.email ?? null,
      name: claims.name ?? null,
      role: 'admin',
    };

    // Register user; first SSO login claims legacy no-auth admin data
    const { claimed_legacy } = ensureAppUser(user);
    if (claimed_legacy) {
      console.log(
        `[auth] first SSO user ${user.username} (${user.id}) claimed legacy autologin data`
      );
    }

    const sessionToken = await createSessionToken(user);
    const res = NextResponse.redirect(
      new URL(safeReturnTo(oauth.returnTo), req.url)
    );
    res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
    res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'OIDC callback failed';
    console.error('[auth/callback]', message);
    return redirectLoginError(req, message);
  }
}
