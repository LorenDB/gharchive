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
  isUnsafeOutboundHostname,
  assetAuthForHostname,
} from '@/lib/safe-url';

describe('isUnsafeOutboundHostname', () => {
  it('blocks loopback and localhost names', () => {
    expect(isUnsafeOutboundHostname('localhost')).toBe(true);
    expect(isUnsafeOutboundHostname('127.0.0.1')).toBe(true);
    expect(isUnsafeOutboundHostname('127.1.2.3')).toBe(true);
    expect(isUnsafeOutboundHostname('::1')).toBe(true);
    expect(isUnsafeOutboundHostname('foo.localhost')).toBe(true);
  });

  it('blocks cloud metadata / link-local', () => {
    expect(isUnsafeOutboundHostname('169.254.169.254')).toBe(true);
    expect(isUnsafeOutboundHostname('169.254.0.1')).toBe(true);
    expect(isUnsafeOutboundHostname('metadata.google.internal')).toBe(true);
    expect(isUnsafeOutboundHostname('metadata')).toBe(true);
  });

  it('allows public and RFC1918 private hosts (self-hosted forges)', () => {
    expect(isUnsafeOutboundHostname('github.com')).toBe(false);
    expect(isUnsafeOutboundHostname('git.example.com')).toBe(false);
    expect(isUnsafeOutboundHostname('10.0.0.5')).toBe(false);
    expect(isUnsafeOutboundHostname('192.168.1.10')).toBe(false);
  });
});

describe('assetAuthForHostname', () => {
  const prev = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITLAB_TOKEN: process.env.GITLAB_TOKEN,
    FORGEJO_TOKEN: process.env.FORGEJO_TOKEN,
    CODEBERG_TOKEN: process.env.CODEBERG_TOKEN,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns github token only for github hosts', () => {
    process.env.GITHUB_TOKEN = 'ghp_test';
    process.env.FORGEJO_TOKEN = 'forge_secret';
    expect(assetAuthForHostname('github.com')?.value).toBe('Bearer ghp_test');
    expect(assetAuthForHostname('objects.githubusercontent.com')?.value).toBe(
      'Bearer ghp_test'
    );
    // Must never leak platform tokens to arbitrary/extra hosts
    expect(assetAuthForHostname('evil.com')).toBeNull();
    expect(assetAuthForHostname('git.example.com')).toBeNull();
    expect(assetAuthForHostname('169.254.169.254')).toBeNull();
  });

  it('returns codeberg token only for codeberg.org', () => {
    process.env.CODEBERG_TOKEN = 'cb_tok';
    process.env.FORGEJO_TOKEN = 'forge_secret';
    expect(assetAuthForHostname('codeberg.org')?.value).toBe('token cb_tok');
    expect(assetAuthForHostname('forge.example.com')).toBeNull();
  });
});

describe('isTrustedAssetHost', () => {
  it('accepts GitHub, GitLab, and Codeberg hosts', () => {
    expect(isTrustedAssetHost('github.com')).toBe(true);
    expect(isTrustedAssetHost('api.github.com')).toBe(true);
    expect(isTrustedAssetHost('objects.githubusercontent.com')).toBe(true);
    expect(isTrustedAssetHost('gitlab.com')).toBe(true);
    expect(isTrustedAssetHost('codeberg.org')).toBe(true);
  });

  it('accepts githubusercontent subdomains', () => {
    expect(isTrustedAssetHost('release-assets.githubusercontent.com')).toBe(
      true
    );
    expect(isTrustedAssetHost('foo.bar.githubusercontent.com')).toBe(true);
  });

  it('accepts extra trusted hosts for per-repo forges', () => {
    expect(isTrustedAssetHost('git.example.com', ['git.example.com'])).toBe(
      true
    );
    expect(isTrustedAssetHost('git.example.com')).toBe(false);
  });

  it('rejects arbitrary hosts and never trusts metadata even as extra', () => {
    expect(isTrustedAssetHost('evil.com')).toBe(false);
    expect(isTrustedAssetHost('169.254.169.254')).toBe(false);
    expect(isTrustedAssetHost('localhost')).toBe(false);
    expect(isTrustedAssetHost('github.com.evil.com')).toBe(false);
    expect(
      isTrustedAssetHost('169.254.169.254', ['169.254.169.254'])
    ).toBe(false);
    expect(isTrustedAssetHost('127.0.0.1', ['127.0.0.1'])).toBe(false);
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
    expect(
      parseTrustedAssetUrl('https://169.254.169.254/latest', [
        '169.254.169.254',
      ])
    ).toBeNull();
    expect(
      parseTrustedAssetUrl('https://127.0.0.1/x', ['127.0.0.1'])
    ).toBeNull();
  });

  it('accepts Codeberg release URLs', () => {
    const u = parseTrustedAssetUrl(
      'https://codeberg.org/o/r/releases/download/v1/a.bin'
    );
    expect(u?.hostname).toBe('codeberg.org');
  });

  it('accepts extra hosts for self-hosted forges', () => {
    const u = parseTrustedAssetUrl(
      'https://git.example.com/o/r/releases/download/v1/a.bin',
      ['git.example.com']
    );
    expect(u?.hostname).toBe('git.example.com');
    expect(
      parseTrustedAssetUrl(
        'https://git.example.com/o/r/releases/download/v1/a.bin'
      )
    ).toBeNull();
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
