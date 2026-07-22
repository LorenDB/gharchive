import { describe, expect, it } from 'vitest';
import {
  sealPayload,
  unsealPayload,
  createSessionToken,
  readSessionToken,
  createOAuthStateToken,
  readOAuthStateToken,
  randomUrlSafe,
  pkceChallenge,
  hasSecureSessionSecret,
  sessionCookieOptions,
  clearCookieOptions,
  SESSION_MAX_AGE_SEC,
  OAUTH_MAX_AGE_SEC,
} from '@/lib/session';

describe('sealPayload / unsealPayload', () => {
  it('round-trips a payload', async () => {
    const data = { hello: 'world', num: 42 };
    const token = await sealPayload(data);
    const result = await unsealPayload<typeof data>(token);
    expect(result).toEqual(data);
  });

  it('returns null for null/undefined token', async () => {
    expect(await unsealPayload(null)).toBeNull();
    expect(await unsealPayload(undefined)).toBeNull();
  });

  it('returns null for empty string', async () => {
    expect(await unsealPayload('')).toBeNull();
  });

  it('returns null for malformed token (wrong parts)', async () => {
    expect(await unsealPayload('just-one-part')).toBeNull();
    expect(await unsealPayload('a.b.c')).toBeNull();
  });

  it('returns null for tampered token', async () => {
    const token = await sealPayload({ foo: 'bar' });
    const parts = token.split('.');
    const tampered = `${parts[0]}.tampered_signature`;
    expect(await unsealPayload(tampered)).toBeNull();
  });

  it('returns null for tampered payload', async () => {
    const token = await sealPayload({ foo: 'bar' });
    const parts = token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ foo: 'baz' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = `${tamperedPayload}.${parts[1]}`;
    expect(await unsealPayload(tampered)).toBeNull();
  });
});

describe('createSessionToken / readSessionToken', () => {
  const user = {
    id: 'test-user-1',
    username: 'tester',
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin' as const,
    groups: [] as string[],
  };

  it('round-trips a session token', async () => {
    const token = await createSessionToken(user);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    const payload = await readSessionToken(token);
    expect(payload).toBeTruthy();
    expect(payload!.user).toEqual(user);
    expect(payload!.iat).toBeGreaterThan(0);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
    expect(payload!.exp - payload!.iat).toBe(SESSION_MAX_AGE_SEC);
  });

  it('returns null for null token', async () => {
    expect(await readSessionToken(null)).toBeNull();
  });

  it('returns null for expired token', async () => {
    // Create a token with exp in the past
    const pastPayload = {
      user,
      iat: Math.floor(Date.now() / 1000) - 10000,
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    const expiredToken = await sealPayload(pastPayload);
    expect(await readSessionToken(expiredToken)).toBeNull();
  });

  it('returns null for tampered token', async () => {
    const token = await createSessionToken(user);
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
    // tampered may still validate (unlikely) or not
    const result = await readSessionToken(tampered);
    expect(result).toBeNull(); // with HMAC, any bit flip invalidates
  });
});

describe('OAuth state tokens', () => {
  it('round-trips an OAuth state token', async () => {
    const token = await createOAuthStateToken('state123', 'verifier456', '/dashboard');
    const result = await readOAuthStateToken(token);
    expect(result).toBeTruthy();
    expect(result!.state).toBe('state123');
    expect(result!.codeVerifier).toBe('verifier456');
    expect(result!.returnTo).toBe('/dashboard');
  });

  it('returns null for expired OAuth token', async () => {
    const expiredPayload = {
      state: 's',
      codeVerifier: 'c',
      returnTo: '/',
      exp: Math.floor(Date.now() / 1000) - OAUTH_MAX_AGE_SEC - 1,
    };
    const token = await sealPayload(expiredPayload);
    expect(await readOAuthStateToken(token)).toBeNull();
  });

  it('returns null for missing fields', async () => {
    const bad = await sealPayload({ state: 's', codeVerifier: '', returnTo: '/' });
    expect(await readOAuthStateToken(bad)).toBeNull();
  });
});

describe('randomUrlSafe', () => {
  it('returns a string of expected length characteristics', () => {
    const s = randomUrlSafe(16);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    expect(s.length).toBeLessThanOrEqual(24); // 16 bytes → max 24 base64url chars
  });

  it('produces different values', () => {
    const a = randomUrlSafe();
    const b = randomUrlSafe();
    expect(a).not.toBe(b);
  });

  it('defaults to 32 bytes', () => {
    const s = randomUrlSafe();
    expect(s.length).toBeGreaterThanOrEqual(40); // 32 bytes
  });
});

describe('pkceChallenge', () => {
  it('generates a challenge from verifier', async () => {
    const verifier = randomUrlSafe();
    const challenge = await pkceChallenge(verifier);
    expect(typeof challenge).toBe('string');
    expect(challenge.length).toBeGreaterThan(0);
    expect(challenge).not.toBe(verifier);
  });

  it('is deterministic for same verifier', async () => {
    const verifier = 'test-verifier-12345';
    const a = await pkceChallenge(verifier);
    const b = await pkceChallenge(verifier);
    expect(a).toBe(b);
  });

  it('produces different challenges for different verifiers', async () => {
    const a = await pkceChallenge('verifier-a');
    const b = await pkceChallenge('verifier-b');
    expect(a).not.toBe(b);
  });
});

describe('hasSecureSessionSecret', () => {
  it('returns false with dev default (short)', () => {
    process.env.SESSION_SECRET = '';
    expect(hasSecureSessionSecret()).toBe(false);
  });

  it('returns true with sufficient length secret', () => {
    process.env.SESSION_SECRET = 'this-is-a-test-secret-at-least-16';
    expect(hasSecureSessionSecret()).toBe(true);
  });
});

describe('sessionCookieOptions', () => {
  it('returns httpOnly and lax sameSite', () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(SESSION_MAX_AGE_SEC);
  });

  it('accepts custom maxAge', () => {
    const opts = sessionCookieOptions(3600);
    expect(opts.maxAge).toBe(3600);
  });
});

describe('clearCookieOptions', () => {
  it('returns zero maxAge', () => {
    const opts = clearCookieOptions();
    expect(opts.maxAge).toBe(0);
    expect(opts.httpOnly).toBe(true);
  });
});
