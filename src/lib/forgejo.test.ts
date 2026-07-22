import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearForgejoHostCache,
  detectForgejoHost,
  fetchForgejoReleases,
  fetchForgejoRepoMeta,
  forgejoApiBase,
  hostInfoFromCloneUrl,
  isKnownForgejoHost,
  normalizeHostname,
} from '@/lib/forgejo';

afterEach(() => {
  clearForgejoHostCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeHostname / known hosts', () => {
  it('strips www and trailing dots', () => {
    expect(normalizeHostname('WWW.Codeberg.org.')).toBe('codeberg.org');
  });

  it('recognizes codeberg as known Forgejo', () => {
    expect(isKnownForgejoHost('codeberg.org')).toBe(true);
    expect(isKnownForgejoHost('www.codeberg.org')).toBe(true);
    expect(isKnownForgejoHost('git.example.com')).toBe(false);
  });
});

describe('forgejoApiBase', () => {
  it('builds v1 base URL', () => {
    expect(forgejoApiBase('codeberg.org')).toBe(
      'https://codeberg.org/api/v1'
    );
  });

  it('includes non-default ports', () => {
    expect(forgejoApiBase('git.example.com', '3000')).toBe(
      'https://git.example.com:3000/api/v1'
    );
  });
});

describe('hostInfoFromCloneUrl', () => {
  it('parses https clone URLs', () => {
    expect(
      hostInfoFromCloneUrl('https://codeberg.org/owner/repo.git')
    ).toEqual({ hostname: 'codeberg.org', port: null });
  });

  it('parses custom ports', () => {
    expect(
      hostInfoFromCloneUrl('https://git.example.com:3000/o/r.git')
    ).toEqual({ hostname: 'git.example.com', port: '3000' });
  });

  it('parses SSH', () => {
    expect(hostInfoFromCloneUrl('git@codeberg.org:o/r.git')).toEqual({
      hostname: 'codeberg.org',
      port: null,
    });
  });
});

describe('detectForgejoHost', () => {
  it('short-circuits known Codeberg without fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(detectForgejoHost('codeberg.org')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects Forgejo via /api/v1/version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '7.0.0+gitea-1.22.0' }),
      })
    );
    await expect(detectForgejoHost('git.example.com')).resolves.toBe(true);
  });

  it('returns false when version endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 })
    );
    await expect(detectForgejoHost('not-a-forge.example')).resolves.toBe(
      false
    );
  });

  it('caches negative results', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    await detectForgejoHost('cache-me.example');
    await detectForgejoHost('cache-me.example');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchForgejoRepoMeta', () => {
  it('maps Forgejo repo fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          description: 'A forge',
          topics: ['git', 'forge'],
          language: 'Go',
          website: 'https://example.org',
          stars_count: 42,
          forks_count: 7,
          private: false,
          archived: false,
          fork: false,
          updated_at: '2026-01-01T00:00:00Z',
          license: { spdx_id: 'MIT' },
        }),
      })
    );

    const meta = await fetchForgejoRepoMeta('codeberg.org', 'o', 'r');
    expect(meta.remote_description).toBe('A forge');
    expect(meta.topics).toEqual(['git', 'forge']);
    expect(meta.language).toBe('Go');
    expect(meta.homepage).toBe('https://example.org');
    expect(meta.stargazers_count).toBe(42);
    expect(meta.forks_count).toBe(7);
    expect(meta.license).toBe('MIT');
    expect(meta.is_private).toBe(false);
  });
});

describe('fetchForgejoReleases', () => {
  it('maps release assets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            tag_name: 'v1.0.0',
            name: '1.0',
            body: 'notes',
            published_at: '2026-01-02T00:00:00Z',
            assets: [
              {
                name: 'app.bin',
                size: 100,
                content_type: 'application/octet-stream',
                browser_download_url:
                  'https://codeberg.org/o/r/releases/download/v1.0.0/app.bin',
              },
            ],
          },
        ],
      })
    );

    const releases = await fetchForgejoReleases('codeberg.org', 'o', 'r');
    expect(releases).toHaveLength(1);
    expect(releases[0]!.tag_name).toBe('v1.0.0');
    expect(releases[0]!.assets[0]!.name).toBe('app.bin');
    expect(releases[0]!.assets[0]!.download_url).toContain('app.bin');
  });
});
