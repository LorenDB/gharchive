import path from 'path';
import fs from 'fs';
import os from 'os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  isTrustedAssetHost,
  parseTrustedAssetUrl,
  isPathInside,
  safeContentDispositionFilename,
  contentDisposition,
} from '@/lib/safe-url';

describe('isTrustedAssetHost', () => {
  it('accepts GitHub and GitLab hosts', () => {
    expect(isTrustedAssetHost('github.com')).toBe(true);
    expect(isTrustedAssetHost('api.github.com')).toBe(true);
    expect(isTrustedAssetHost('objects.githubusercontent.com')).toBe(true);
    expect(isTrustedAssetHost('gitlab.com')).toBe(true);
  });

  it('accepts githubusercontent subdomains', () => {
    expect(isTrustedAssetHost('release-assets.githubusercontent.com')).toBe(
      true
    );
    expect(isTrustedAssetHost('foo.bar.githubusercontent.com')).toBe(true);
  });

  it('rejects arbitrary hosts', () => {
    expect(isTrustedAssetHost('evil.com')).toBe(false);
    expect(isTrustedAssetHost('169.254.169.254')).toBe(false);
    expect(isTrustedAssetHost('localhost')).toBe(false);
    expect(isTrustedAssetHost('github.com.evil.com')).toBe(false);
  });
});

describe('parseTrustedAssetUrl', () => {
  it('accepts https GitHub asset URLs', () => {
    const u = parseTrustedAssetUrl(
      'https://github.com/owner/repo/releases/download/v1/a.zip'
    );
    expect(u?.hostname).toBe('github.com');
  });

  it('rejects http', () => {
    expect(
      parseTrustedAssetUrl('http://github.com/owner/repo/releases/download/v1/a.zip')
    ).toBeNull();
  });

  it('rejects untrusted hosts', () => {
    expect(parseTrustedAssetUrl('https://evil.com/payload')).toBeNull();
    expect(parseTrustedAssetUrl('https://169.254.169.254/latest')).toBeNull();
  });

  it('rejects credentials in URL', () => {
    expect(
      parseTrustedAssetUrl('https://user:pass@github.com/a/b')
    ).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(parseTrustedAssetUrl('file:///etc/passwd')).toBeNull();
    expect(parseTrustedAssetUrl('ftp://github.com/a')).toBeNull();
  });
});

describe('isPathInside', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-path-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts paths under parent', () => {
    const child = path.join(tmp, 'a', 'b.zip');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(child, 'x');
    expect(isPathInside(tmp, child)).toBe(true);
  });

  it('rejects paths outside parent', () => {
    expect(isPathInside(tmp, path.join(tmp, '..', 'etc', 'passwd'))).toBe(
      false
    );
    expect(isPathInside(tmp, '/etc/passwd')).toBe(false);
  });
});

describe('safeContentDispositionFilename', () => {
  it('strips quotes and CR/LF', () => {
    expect(safeContentDispositionFilename('a"b\r\nX: y')).not.toMatch(
      /["\r\n]/
    );
  });

  it('uses basename only', () => {
    expect(safeContentDispositionFilename('/etc/passwd')).toBe('passwd');
    expect(safeContentDispositionFilename('../../secret')).toBe('secret');
  });

  it('builds disposition header', () => {
    expect(contentDisposition('file.zip')).toBe(
      'attachment; filename="file.zip"'
    );
  });
});
