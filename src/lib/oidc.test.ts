import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  claimsToUsername,
  mergeOidcClaims,
  type OidcClaims,
} from '@/lib/oidc';

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
