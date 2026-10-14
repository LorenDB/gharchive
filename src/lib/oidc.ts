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
  /** Some IdPs (custom mappers) expose this instead of preferred_username */
  username?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  groups?: string[];
  iss?: string;
  aud?: string | string[];
  nonce?: string;
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

  // Issuer must be https (except explicit http://localhost for dev).
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(normalized);
  } catch {
    throw new Error('OIDC issuer is not a valid URL');
  }
  const isLocalDev =
    (issuerUrl.hostname === 'localhost' || issuerUrl.hostname === '127.0.0.1') &&
    issuerUrl.protocol === 'http:';
  if (issuerUrl.protocol !== 'https:' && !isLocalDev) {
    throw new Error('OIDC issuer must use https://');
  }

  const url = `${normalized}/.well-known/openid-configuration`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    // Discovery document is cached in-process (metadataCache); avoid Next data cache
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
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
  // The discovery document must belong to the configured issuer — otherwise a
  // poisoned / MITM'd document could redirect token exchange + userinfo.
  if (typeof meta.issuer === 'string' && meta.issuer.replace(/\/$/, '') !== normalized) {
    throw new Error('OIDC discovery issuer mismatch');
  }
  // Endpoints must be https (except localhost dev) — never allow a discovery
  // document to downgrade the code exchange to http.
  for (const ep of [
    meta.authorization_endpoint,
    meta.token_endpoint,
    meta.userinfo_endpoint,
    meta.jwks_uri,
  ]) {
    if (!ep) continue;
    try {
      const u = new URL(ep);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
        throw new Error(`OIDC endpoint must use https: ${ep.slice(0, 80)}`);
      }
    } catch (e: any) {
      if (e?.message?.startsWith('OIDC endpoint')) throw e;
      throw new Error('OIDC discovery contains an invalid endpoint URL');
    }
  }

  metadataCache = { issuer: normalized, meta, fetchedAt: Date.now() };
  return meta;
}

export function buildAuthorizationUrl(opts: {
  meta: OidcMetadata;
  config: OidcConfig;
  state: string;
  codeChallenge: string;
  nonce: string;
}): string {
  const { meta, config, state, codeChallenge, nonce } = opts;
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scopes,
    redirect_uri: config.redirectUri,
    state,
    nonce,
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
  if (!code || typeof code !== 'string' || code.length > 4000) {
    throw new Error('Invalid authorization code');
  }
  if (!codeVerifier || typeof codeVerifier !== 'string' || codeVerifier.length > 2000) {
    throw new Error('Invalid PKCE verifier');
  }
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
    signal: AbortSignal.timeout(15_000),
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
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length > 8000) {
    throw new Error('Invalid access token');
  }
  const res = await fetch(meta.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`OIDC userinfo failed (${res.status})`);
  }
  return (await res.json()) as OidcClaims;
}

/** Decode JWT payload without cryptographic verification. */
function rawDecodeJwtPayload(jwt: string): OidcClaims | null {
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

/**
 * Decode and validate id_token JWT payload (structural checks).
 * Tokens are obtained only from the IdP token endpoint over HTTPS; full JWKS
 * signature verification is not implemented (defense-in-depth for later).
 * Always validates iss/aud/nonce/exp when expected values are provided.
 *
 * NOTE: without JWKS verification this is not proof of authenticity against a
 * malicious token endpoint — discovery + TLS (see fetchOidcMetadata) is the
 * current trust root. Treat `groups` (admin decisions) as untrusted.
 */
export function decodeJwtPayload(
  jwt: string,
  opts?: { expectedIssuer?: string; expectedClientId?: string; expectedNonce?: string }
): OidcClaims | null {
  if (!jwt || typeof jwt !== 'string' || jwt.length > 16000) return null;
  const claims = rawDecodeJwtPayload(jwt);
  if (!claims?.sub) return null;
  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 512) {
    return null;
  }

  // OIDC Core §3.1.3.7 — issuer must match
  if (opts?.expectedIssuer) {
    if (!claims.iss || claims.iss !== opts.expectedIssuer) {
      console.error(
        '[oidc] id_token iss mismatch:',
        claims.iss,
        'expected:',
        opts.expectedIssuer
      );
      return null;
    }
  }

  // aud is required when we know the client id (must include our client_id)
  if (opts?.expectedClientId) {
    if (claims.aud == null || claims.aud === '') {
      console.error('[oidc] id_token missing aud claim');
      return null;
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.expectedClientId)) {
      console.error(
        '[oidc] id_token aud mismatch:',
        claims.aud,
        'expected:',
        opts.expectedClientId
      );
      return null;
    }
  }

  // exp is required; reject expired tokens (60s clock skew allowed)
  const exp = (claims as OidcClaims & { exp?: number }).exp;
  if (typeof exp === 'number') {
    const now = Math.floor(Date.now() / 1000);
    if (exp + 60 < now) {
      console.error('[oidc] id_token expired');
      return null;
    }
    // Reject tokens with exp absurdly far in the future (likely forged).
    if (exp > now + 24 * 3600) {
      console.error('[oidc] id_token exp too far in future');
      return null;
    }
  } else if (opts?.expectedIssuer || opts?.expectedClientId) {
    // When performing OIDC validation, require exp
    console.error('[oidc] id_token missing exp claim');
    return null;
  }

  // iat: must exist when validating; reject future-dated tokens (>5m skew).
  const iat = (claims as OidcClaims & { iat?: number }).iat;
  if (opts?.expectedIssuer || opts?.expectedClientId) {
    if (typeof iat === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (iat > now + 300) {
        console.error('[oidc] id_token iat in future');
        return null;
      }
    }
    // nbf: reject not-yet-valid tokens (>5m skew).
    const nbf = (claims as OidcClaims & { nbf?: number }).nbf;
    if (typeof nbf === 'number') {
      const now = Math.floor(Date.now() / 1000);
      if (nbf > now + 300) {
        console.error('[oidc] id_token not yet valid (nbf)');
        return null;
      }
    }
    // azp: when aud has multiple audiences, azp must be our client id.
    const audArr = Array.isArray(claims.aud)
      ? claims.aud
      : claims.aud
        ? [claims.aud]
        : [];
    if (audArr.length > 1) {
      const azp = (claims as OidcClaims & { azp?: string }).azp;
      if (azp !== opts.expectedClientId) {
        console.error('[oidc] id_token azp mismatch for multi-audience token');
        return null;
      }
    }
  }

  // Validate nonce to prevent id_token replay attacks (OIDC Core 1.0 §3.1.3.7)
  // Constant-time compare to avoid leaking nonce prefix via timing.
  if (opts?.expectedNonce) {
    if (!claims.nonce || typeof claims.nonce !== 'string') {
      console.error('[oidc] id_token missing nonce claim');
      return null;
    }
    if (!timingSafeEqualStr(claims.nonce, opts.expectedNonce)) {
      console.error('[oidc] id_token nonce mismatch');
      return null;
    }
  }

  return claims;
}

/** Constant-time string equality (length + content) for nonces/state. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

/** Low-level decode: raw payload without validation. Prefer decodeJwtPayload. */
function rawDecodeForTests(jwt: string): OidcClaims | null {
  return rawDecodeJwtPayload(jwt);
}

export { rawDecodeForTests };

export function getAdminGroup(): string | null {
  return process.env.OIDC_ADMIN_GROUP?.trim() || null;
}

export function getOidcProviderName(): string {
  return process.env.OIDC_PROVIDER_NAME?.trim() || 'SSO';
}

/** True when a claim value is usable (non-empty string / non-empty array). */
function hasClaimValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Merge OIDC claim sources (typically validated id_token + userinfo).
 *
 * Overlay wins on non-empty *profile* fields so userinfo can update display
 * data, but a sparse userinfo response (e.g. only `sub`) does not wipe
 * preferred_username / email / name / groups that only appear on the id_token.
 *
 * Security-critical claims (iss/aud/nonce/exp/iat/nbf/azp) are never taken
 * from the overlay — they stay pinned to the nonce-validated id_token base.
 * On `sub` mismatch, prefer the base (usually nonce-validated id_token).
 */
const SECURITY_CLAIM_KEYS = new Set([
  'iss',
  'aud',
  'nonce',
  'exp',
  'iat',
  'nbf',
  'azp',
  'auth_time',
  'at_hash',
  'c_hash',
]);
export function mergeOidcClaims(
  base: OidcClaims | null | undefined,
  overlay: OidcClaims | null | undefined
): OidcClaims | null {
  if (!base && !overlay) return null;
  if (!base) return { ...overlay! };
  if (!overlay) return { ...base };

  const merged: OidcClaims = { ...base };

  const keys = Object.keys(overlay) as (keyof OidcClaims)[];
  for (const key of keys) {
    if (key === 'sub') continue;
    if (SECURITY_CLAIM_KEYS.has(key as string)) continue;
    const value = overlay[key];
    if (!hasClaimValue(value)) continue;
    // Groups from userinfo are untrusted for privilege decisions unless they
    // also appear on the validated id_token — still merge for display, but the
    // callback must decide admin from id_token groups when present.
    Object.assign(merged, { [key]: value });
  }

  if (base.sub && overlay.sub && base.sub !== overlay.sub) {
    console.error(
      '[oidc] sub mismatch between claim sources:',
      base.sub,
      'vs',
      overlay.sub,
      '— keeping base sub'
    );
    merged.sub = base.sub;
  } else {
    merged.sub = overlay.sub || base.sub;
  }

  return merged;
}

/**
 * Pick a human-readable username from OIDC claims.
 * Falls back to `sub` only when no profile/email identity is available
 * (often a UUID — callers may want display fallbacks in that case).
 */
export function claimsToUsername(claims: OidcClaims): string {
  const emailLocal = claims.email?.includes('@')
    ? claims.email.split('@')[0]
    : claims.email;
  const candidates = [
    claims.preferred_username,
    claims.username,
    claims.nickname,
    emailLocal,
    claims.name,
    claims.given_name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return claims.sub;
}
