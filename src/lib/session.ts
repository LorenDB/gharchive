/**
 * Signed session cookies that work in both Edge (middleware) and Node.
 * Format: base64url(payload).base64url(hmac-sha256)
 */

const encoder = new TextEncoder();

export interface SessionUser {
  /** OIDC `sub`, or `autologin` in no-auth mode */
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  role: 'admin';
}

export interface SessionPayload {
  user: SessionUser;
  /** Unix seconds */
  exp: number;
  /** Unix seconds */
  iat: number;
}

export interface OAuthStatePayload {
  state: string;
  codeVerifier: string;
  returnTo: string;
  /** Unix seconds */
  exp: number;
}

const SESSION_COOKIE = 'gharchive_session';
const OAUTH_COOKIE = 'gharchive_oauth';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days
const OAUTH_MAX_AGE_SEC = 60 * 10; // 10 minutes

export {
  SESSION_COOKIE,
  OAUTH_COOKIE,
  SESSION_MAX_AGE_SEC,
  OAUTH_MAX_AGE_SEC,
};

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  // Dev / autologin only — OIDC paths refuse to mint sessions without a secret.
  return 'gharchive-dev-insecure-session-secret';
}

export function hasSecureSessionSecret(): boolean {
  const secret = process.env.SESSION_SECRET?.trim();
  return Boolean(secret && secret.length >= 16);
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = encoder.encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToString(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(payloadB64: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  return base64UrlEncode(sig);
}

async function verifySig(
  payloadB64: string,
  sigB64: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await hmacKey(secret);
    const padded = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const sigBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      sigBytes[i] = binary.charCodeAt(i);
    }
    return crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(payloadB64)
    );
  } catch {
    return false;
  }
}

export async function sealPayload<T extends object>(
  payload: T,
  secret = getSessionSecret()
): Promise<string> {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = await sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function unsealPayload<T>(
  token: string | undefined | null,
  secret = getSessionSecret()
): Promise<T | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;
  if (!(await verifySig(payloadB64, sigB64, secret))) return null;
  try {
    const json = base64UrlDecodeToString(payloadB64);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  if (!hasSecureSessionSecret() && process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is required when OIDC is enabled (min 16 characters)'
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    user,
    iat: now,
    exp: now + SESSION_MAX_AGE_SEC,
  };
  return sealPayload(payload);
}

export async function readSessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  const payload = await unsealPayload<SessionPayload>(token);
  if (!payload?.user || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function createOAuthStateToken(
  state: string,
  codeVerifier: string,
  returnTo: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: OAuthStatePayload = {
    state,
    codeVerifier,
    returnTo,
    exp: now + OAUTH_MAX_AGE_SEC,
  };
  return sealPayload(payload);
}

export async function readOAuthStateToken(
  token: string | undefined | null
): Promise<OAuthStatePayload | null> {
  const payload = await unsealPayload<OAuthStatePayload>(token);
  if (!payload?.state || !payload.codeVerifier) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Secure cookies when APP_URL is https (works for HTTP Docker on localhost). */
function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const appUrl =
    process.env.APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim() ||
    '';
  return appUrl.startsWith('https://');
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SEC) {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export function clearCookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}

/** Random URL-safe string for state / code_verifier */
export function randomUrlSafe(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64UrlEncode(digest);
}
