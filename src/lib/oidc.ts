/**
 * OpenID Connect (authorization code + PKCE) helpers.
 * Discovery via the issuer's .well-known/openid-configuration.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  jwks_uri?: string;
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
}

let metadataCache: { issuer: string; meta: OidcMetadata; fetchedAt: number } | null =
  null;
const METADATA_TTL_MS = 60 * 60 * 1000;

/** True when enough env is set to run OIDC login. */
export function isOidcConfigured(): boolean {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  return Boolean(issuer && clientId);
}

export function getAppUrl(): string {
  const url =
    process.env.APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.AUTH_URL?.trim();
  if (url) return url.replace(/\/$/, '');
  // Sensible local default for Docker / dev
  return 'http://localhost:3000';
}

/**
 * Absolute URL for app-facing redirects (login, post-auth).
 * Prefer APP_URL so Docker internal hostnames never leak into the browser.
 */
export function appUrl(path = '/'): string {
  const base = getAppUrl();
  if (!path || path === '/') return `${base}/`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function getOidcConfig(): OidcConfig | null {
  if (!isOidcConfigured()) return null;
  const issuer = process.env.OIDC_ISSUER!.trim().replace(/\/$/, '');
  const clientId = process.env.OIDC_CLIENT_ID!.trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim() || '';
  const scopes =
    process.env.OIDC_SCOPES?.trim() || 'openid profile email';
  const redirectUri =
    process.env.OIDC_REDIRECT_URI?.trim() ||
    `${getAppUrl()}/api/auth/callback`;
  return { issuer, clientId, clientSecret, scopes, redirectUri };
}

export async function fetchOidcMetadata(issuer: string): Promise<OidcMetadata> {
  const normalized = issuer.replace(/\/$/, '');
  if (
    metadataCache &&
    metadataCache.issuer === normalized &&
    Date.now() - metadataCache.fetchedAt < METADATA_TTL_MS
  ) {
    return metadataCache.meta;
  }

  const url = `${normalized}/.well-known/openid-configuration`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    // Discovery document is cached in-process (metadataCache); avoid Next data cache
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (${res.status}): ${url}`
    );
  }

  const meta = (await res.json()) as OidcMetadata;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('OIDC discovery document missing authorization or token endpoint');
  }

  metadataCache = { issuer: normalized, meta, fetchedAt: Date.now() };
  return meta;
}

export function buildAuthorizationUrl(opts: {
  meta: OidcMetadata;
  config: OidcConfig;
  state: string;
  codeChallenge: string;
}): string {
  const { meta, config, state, codeChallenge } = opts;
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scopes,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${meta.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeCode(opts: {
  meta: OidcMetadata;
  config: OidcConfig;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const { meta, config, code, codeVerifier } = opts;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OIDC token exchange failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  return (await res.json()) as TokenResponse;
}

export async function fetchUserInfo(
  meta: OidcMetadata,
  accessToken: string
): Promise<OidcClaims> {
  if (!meta.userinfo_endpoint) {
    throw new Error('OIDC provider has no userinfo_endpoint');
  }
  const res = await fetch(meta.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`OIDC userinfo failed (${res.status})`);
  }
  return (await res.json()) as OidcClaims;
}

/** Decode JWT payload without verification (id_token fallback when no userinfo). */
export function decodeJwtPayload(jwt: string): OidcClaims | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = atob(padded + pad);
    return JSON.parse(json) as OidcClaims;
  } catch {
    return null;
  }
}

export function claimsToUsername(claims: OidcClaims): string {
  return (
    claims.preferred_username ||
    claims.nickname ||
    claims.email?.split('@')[0] ||
    claims.name ||
    claims.sub
  );
}
