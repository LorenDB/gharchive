import { describe, expect, it } from 'vitest';
import {
  classifyAssetHost,
  hostnameFromAssetUrl,
  normalizeAssetHostname,
} from '@/lib/asset-hosts';

describe('normalizeAssetHostname', () => {
  it('normalizes and strips www', () => {
    expect(normalizeAssetHostname('WWW.CDN.Example.COM.')).toBe(
      'cdn.example.com'
    );
  });

  it('rejects invalid', () => {
    expect(normalizeAssetHostname('')).toBeNull();
    expect(normalizeAssetHostname('https://evil.com')).toBeNull();
    expect(normalizeAssetHostname('a/b')).toBeNull();
    expect(normalizeAssetHostname('has space.com')).toBeNull();
  });
});

describe('hostnameFromAssetUrl', () => {
  it('extracts https host', () => {
    expect(
      hostnameFromAssetUrl(
        'https://cdn.example.com/o/r/releases/download/v1/a.bin'
      )
    ).toBe('cdn.example.com');
  });

  it('rejects non-https and credentials', () => {
    expect(hostnameFromAssetUrl('http://cdn.example.com/a')).toBeNull();
    expect(
      hostnameFromAssetUrl('https://user:pass@cdn.example.com/a')
    ).toBeNull();
  });
});

describe('classifyAssetHost', () => {
  const settings = {
    approved_asset_hosts: ['cdn.example.com'],
    rejected_asset_hosts: ['evil.example.com'],
  };

  it('trusts built-in hosts', () => {
    expect(classifyAssetHost('github.com', [], settings)).toBe('trusted');
    expect(classifyAssetHost('codeberg.org', [], settings)).toBe('trusted');
  });

  it('trusts extra (repo) hosts', () => {
    expect(
      classifyAssetHost('git.example.com', ['git.example.com'], settings)
    ).toBe('trusted');
  });

  it('recognizes approved and rejected', () => {
    expect(classifyAssetHost('cdn.example.com', [], settings)).toBe(
      'approved'
    );
    expect(classifyAssetHost('evil.example.com', [], settings)).toBe(
      'rejected'
    );
  });

  it('returns unknown for other hosts', () => {
    expect(classifyAssetHost('other.example.com', [], settings)).toBe(
      'unknown'
    );
  });

  it('rejected wins over extra hosts', () => {
    expect(
      classifyAssetHost('evil.example.com', ['evil.example.com'], settings)
    ).toBe('rejected');
  });
});
