import { describe, expect, it } from 'vitest';
import {
  runAsUser,
  runAsUserAsync,
  tryGetUserId,
  getRequiredUserId,
  safeUserPathSegment,
  AUTOLOGIN_USER_ID,
} from '@/lib/user-context';

describe('runAsUser', () => {
  it('sets user context synchronously', () => {
    runAsUser('user-1', () => {
      expect(tryGetUserId()).toBe('user-1');
    });
  });

  it('does not leak context outside', () => {
    runAsUser('user-a', () => {
      expect(tryGetUserId()).toBe('user-a');
    });
    expect(tryGetUserId()).toBeUndefined();
  });

  it('can be nested (inner overrides)', () => {
    runAsUser('outer', () => {
      expect(tryGetUserId()).toBe('outer');
      runAsUser('inner', () => {
        expect(tryGetUserId()).toBe('inner');
      });
      expect(tryGetUserId()).toBe('outer');
    });
  });
});

describe('runAsUserAsync', () => {
  it('sets user context for async functions', async () => {
    const result = await runAsUserAsync('user-async', async () => {
      await Promise.resolve();
      return tryGetUserId();
    });
    expect(result).toBe('user-async');
  });

  it('does not leak context after async', async () => {
    await runAsUserAsync('temp', async () => {
      expect(tryGetUserId()).toBe('temp');
    });
    expect(tryGetUserId()).toBeUndefined();
  });
});

describe('tryGetUserId', () => {
  it('returns undefined when no context', () => {
    expect(tryGetUserId()).toBeUndefined();
  });

  it('returns userId when in context', () => {
    runAsUser('ctx-test', () => {
      expect(tryGetUserId()).toBe('ctx-test');
    });
  });
});

describe('getRequiredUserId', () => {
  it('throws when no context is active', () => {
    expect(() => getRequiredUserId()).toThrow('No user context');
  });

  it('returns userId when in context', () => {
    runAsUser('required-test', () => {
      expect(getRequiredUserId()).toBe('required-test');
    });
  });
});

describe('safeUserPathSegment', () => {
  it('preserves valid characters', () => {
    expect(safeUserPathSegment('john.doe_test-123')).toBe('john.doe_test-123');
  });

  it('replaces invalid characters with underscores', () => {
    expect(safeUserPathSegment('john doe')).toBe('john_doe');
    expect(safeUserPathSegment('user@domain.com')).toBe('user_domain.com');
    expect(safeUserPathSegment('a/b\\c:d')).toBe('a_b_c_d');
  });

  it('strips leading dots', () => {
    expect(safeUserPathSegment('..hidden')).toBe('hidden');
    expect(safeUserPathSegment('.config')).toBe('config');
  });

  it('handles completely invalid input', () => {
    // all invalid chars replaced with _, result is '_' which is truthy so returned as-is
    expect(safeUserPathSegment('!@#$%')).toBe('_');
    expect(safeUserPathSegment('')).toBe('user');
    expect(safeUserPathSegment('...')).toBe('user');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(safeUserPathSegment(long).length).toBe(80);
  });
});

describe('AUTOLOGIN_USER_ID', () => {
  it('is the value used for no-auth mode', () => {
    expect(AUTOLOGIN_USER_ID).toBe('autologin');
  });
});
