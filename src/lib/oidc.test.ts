import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  claimsToUsername,
  decodeJwtPayload,
  mergeOidcClaims,
  type OidcClaims,
} from '@/lib/oidc';

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' })
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('mergeOidcClaims', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when both sides missing', () => {
    expect(mergeOidcClaims(null, null)).toBeNull();
    expect(mergeOidcClaims(undefined, undefined)).toBeNull();
  });

  it('returns the non-null side alone', () => {
    const a: OidcClaims = { sub: 'a', email: 'a@example.com' };
    expect(mergeOidcClaims(a, null)).toEqual(a);
    expect(mergeOidcClaims(null, a)).toEqual(a);
  });

  it('keeps id_token profile when userinfo is sparse (sub only)', () => {
    const idToken: OidcClaims = {
      sub: 'uuid-1',
      preferred_username: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      groups: ['admins'],
    };
    const userinfo: OidcClaims = { sub: 'uuid-1' };

    expect(mergeOidcClaims(idToken, userinfo)).toEqual({
      sub: 'uuid-1',
      preferred_username: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      groups: ['admins'],
    });
  });

  it('lets non-empty userinfo fields override id_token', () => {
    const idToken: OidcClaims = {
      sub: 'uuid-1',
      preferred_username: 'old',
      email: 'old@example.com',
      name: 'Old Name',
    };
    const userinfo: OidcClaims = {
      sub: 'uuid-1',
      preferred_username: 'new',
      email: 'new@example.com',
    };

    expect(mergeOidcClaims(idToken, userinfo)).toEqual({
      sub: 'uuid-1',
      preferred_username: 'new',
      email: 'new@example.com',
      name: 'Old Name',
    });
  });

  it('ignores empty-string overlay values', () => {
    const idToken: OidcClaims = {
      sub: 'uuid-1',
      email: 'alice@example.com',
      name: 'Alice',
    };
    const userinfo: OidcClaims = {
      sub: 'uuid-1',
      email: '',
      name: '   ',
    };

    expect(mergeOidcClaims(idToken, userinfo)).toEqual({
      sub: 'uuid-1',
      email: 'alice@example.com',
      name: 'Alice',
    });
  });

  it('keeps base groups when overlay groups are empty', () => {
    const idToken: OidcClaims = {
      sub: 'uuid-1',
      groups: ['gharchive-admins'],
    };
    const userinfo: OidcClaims = {
      sub: 'uuid-1',
      groups: [],
    };

    expect(mergeOidcClaims(idToken, userinfo)?.groups).toEqual([
      'gharchive-admins',
    ]);
  });

  it('prefers base sub on mismatch', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const idToken: OidcClaims = { sub: 'token-sub', name: 'A' };
    const userinfo: OidcClaims = { sub: 'userinfo-sub', name: 'B' };

    const merged = mergeOidcClaims(idToken, userinfo);
    expect(merged?.sub).toBe('token-sub');
    expect(merged?.name).toBe('B');
    expect(err).toHaveBeenCalled();
  });
});

describe('decodeJwtPayload', () => {
  const base = {
    sub: 'user-1',
    iss: 'https://idp.example.com',
    aud: 'client-1',
    nonce: 'n-abc',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it('accepts a valid payload with expected checks', () => {
    const claims = decodeJwtPayload(fakeJwt(base), {
      expectedIssuer: base.iss,
      expectedClientId: 'client-1',
      expectedNonce: 'n-abc',
    });
    expect(claims?.sub).toBe('user-1');
  });

  it('rejects missing aud when client id expected', () => {
    const { aud: _a, ...noAud } = base;
    expect(
      decodeJwtPayload(fakeJwt(noAud), {
        expectedIssuer: base.iss,
        expectedClientId: 'client-1',
        expectedNonce: 'n-abc',
      })
    ).toBeNull();
  });

  it('rejects wrong aud', () => {
    expect(
      decodeJwtPayload(fakeJwt({ ...base, aud: 'other' }), {
        expectedClientId: 'client-1',
      })
    ).toBeNull();
  });

  it('rejects expired tokens', () => {
    expect(
      decodeJwtPayload(
        fakeJwt({ ...base, exp: Math.floor(Date.now() / 1000) - 120 }),
        {
          expectedIssuer: base.iss,
          expectedClientId: 'client-1',
          expectedNonce: 'n-abc',
        }
      )
    ).toBeNull();
  });

  it('rejects missing exp when validating OIDC', () => {
    const { exp: _e, ...noExp } = base;
    expect(
      decodeJwtPayload(fakeJwt(noExp), {
        expectedIssuer: base.iss,
        expectedClientId: 'client-1',
        expectedNonce: 'n-abc',
      })
    ).toBeNull();
  });

  it('rejects iss mismatch', () => {
    expect(
      decodeJwtPayload(fakeJwt(base), {
        expectedIssuer: 'https://evil.example.com',
        expectedClientId: 'client-1',
        expectedNonce: 'n-abc',
      })
    ).toBeNull();
  });
});

describe('claimsToUsername', () => {
  it('prefers preferred_username', () => {
    expect(
      claimsToUsername({
        sub: 'uuid',
        preferred_username: 'alice',
        email: 'alice@example.com',
        name: 'Alice',
      })
    ).toBe('alice');
  });

  it('uses custom username claim', () => {
    expect(
      claimsToUsername({
        sub: 'uuid',
        username: 'bob',
      })
    ).toBe('bob');
  });

  it('uses email local-part', () => {
    expect(
      claimsToUsername({
        sub: 'uuid',
        email: 'carol@example.com',
      })
    ).toBe('carol');
  });

  it('uses given_name before falling back to sub', () => {
    expect(
      claimsToUsername({
        sub: 'uuid',
        given_name: 'Dana',
      })
    ).toBe('Dana');
  });

  it('falls back to sub when no profile claims', () => {
    expect(claimsToUsername({ sub: '550e8400-e29b-41d4-a716-446655440000' })).toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('trims whitespace', () => {
    expect(
      claimsToUsername({
        sub: 'uuid',
        preferred_username: '  eve  ',
      })
    ).toBe('eve');
  });
});
