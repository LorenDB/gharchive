import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsUser, AUTOLOGIN_USER_ID } from '@/lib/user-context';
import {
  DEFAULT_SETTINGS,
  addRelease,
  addReleaseAsset,
  createArchive,
  getArchiveReleaseAssetPolicy,
  getArchiveReleasesSorted,
  linkUserToArchive,
  mergeReleaseAssetPolicies,
  normalizeSettings,
  pruneReleaseAssets,
  resetDbForTests,
  resolveReleaseAssetPolicy,
  shouldCacheReleaseAtIndex,
  updateRepo,
  updateSettings,
  warmDb,
} from '@/lib/db';

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-rap-'));
  process.env.DATA_DIR = tempDir;
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('normalizeSettings / resolveReleaseAssetPolicy', () => {
  it('migrates legacy download_release_assets false → none', () => {
    // Old stored settings had only the boolean (no release_asset_mode key)
    const s = normalizeSettings({
      download_release_assets: false,
    } as Partial<typeof DEFAULT_SETTINGS>);
    expect(s.release_asset_mode).toBe('none');
    expect(s.download_release_assets).toBe(false);
  });

  it('does not let DEFAULT mode override explicit last_n', () => {
    const s = normalizeSettings({
      release_asset_mode: 'last_n',
      release_asset_keep_last: 3,
      download_release_assets: true,
    } as Partial<typeof DEFAULT_SETTINGS>);
    expect(s.release_asset_mode).toBe('last_n');
    expect(s.release_asset_keep_last).toBe(3);
  });

  it('keeps last_n and clamps keep_last', () => {
    const s = normalizeSettings({
      release_asset_mode: 'last_n',
      release_asset_keep_last: 0,
    } as any);
    expect(s.release_asset_mode).toBe('last_n');
    expect(s.release_asset_keep_last).toBe(DEFAULT_SETTINGS.release_asset_keep_last);
    expect(s.download_release_assets).toBe(true);
  });

  it('inherits settings when membership has no override', () => {
    const settings = normalizeSettings({
      release_asset_mode: 'last_n',
      release_asset_keep_last: 3,
    } as any);
    expect(resolveReleaseAssetPolicy(settings, null)).toEqual({
      mode: 'last_n',
      keep_last: 3,
    });
    expect(
      resolveReleaseAssetPolicy(settings, {
        release_asset_mode: null,
        release_asset_keep_last: null,
      })
    ).toEqual({ mode: 'last_n', keep_last: 3 });
  });

  it('applies per-repo override', () => {
    const settings = normalizeSettings({
      release_asset_mode: 'all',
      release_asset_keep_last: 5,
    } as any);
    expect(
      resolveReleaseAssetPolicy(settings, {
        release_asset_mode: 'last_n',
        release_asset_keep_last: 2,
      })
    ).toEqual({ mode: 'last_n', keep_last: 2 });
    expect(
      resolveReleaseAssetPolicy(settings, {
        release_asset_mode: 'none',
        release_asset_keep_last: null,
      })
    ).toEqual({ mode: 'none', keep_last: 5 });
  });
});

describe('mergeReleaseAssetPolicies / shouldCacheReleaseAtIndex', () => {
  it('most permissive wins: all beats last_n and none', () => {
    expect(
      mergeReleaseAssetPolicies([
        { mode: 'last_n', keep_last: 2 },
        { mode: 'all', keep_last: 0 },
        { mode: 'none', keep_last: 0 },
      ])
    ).toEqual({ mode: 'all', keep_last: 0 });
  });

  it('max keep_last among last_n policies', () => {
    expect(
      mergeReleaseAssetPolicies([
        { mode: 'last_n', keep_last: 2 },
        { mode: 'last_n', keep_last: 7 },
        { mode: 'none', keep_last: 0 },
      ])
    ).toEqual({ mode: 'last_n', keep_last: 7 });
  });

  it('none when all members want none', () => {
    expect(
      mergeReleaseAssetPolicies([
        { mode: 'none', keep_last: 0 },
        { mode: 'none', keep_last: 0 },
      ])
    ).toEqual({ mode: 'none', keep_last: 0 });
  });

  it('indexes newest-first for last_n', () => {
    const p = { mode: 'last_n' as const, keep_last: 2 };
    expect(shouldCacheReleaseAtIndex(p, 0)).toBe(true);
    expect(shouldCacheReleaseAtIndex(p, 1)).toBe(true);
    expect(shouldCacheReleaseAtIndex(p, 2)).toBe(false);
    expect(shouldCacheReleaseAtIndex({ mode: 'all', keep_last: 0 }, 99)).toBe(
      true
    );
    expect(shouldCacheReleaseAtIndex({ mode: 'none', keep_last: 0 }, 0)).toBe(
      false
    );
  });
});

describe('pruneReleaseAssets', () => {
  it('drops assets outside keep-last-N and preserves metadata', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      warmDb();
      const archive = createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'widget',
        clone_url: 'https://github.com/acme/widget.git',
        mirror_path: path.join(tempDir, 'mirrors', 'github', 'acme', 'widget.git'),
        last_synced_at: null,
        is_private: false,
      });
      const repo = linkUserToArchive(archive.id);
      updateSettings({
        release_asset_mode: 'last_n',
        release_asset_keep_last: 2,
      });

      const tags = [
        { tag: 'v1', published: '2024-01-01T00:00:00Z' },
        { tag: 'v2', published: '2024-06-01T00:00:00Z' },
        { tag: 'v3', published: '2025-01-01T00:00:00Z' },
      ];
      const assetPaths: string[] = [];
      for (const t of tags) {
        const rel = addRelease({
          archive_id: archive.id,
          tag_name: t.tag,
          name: t.tag,
          body: null,
          published_at: t.published,
        });
        const fp = path.join(tempDir, 'assets', `${t.tag}.bin`);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, 'data');
        assetPaths.push(fp);
        addReleaseAsset({
          release_id: rel.id,
          name: `${t.tag}.bin`,
          content_type: 'application/octet-stream',
          size: 4,
          file_path: fp,
          download_url: `https://example.com/${t.tag}.bin`,
        });
      }

      const sorted = getArchiveReleasesSorted(archive.id);
      expect(sorted.map((r) => r.tag_name)).toEqual(['v3', 'v2', 'v1']);

      const dropped = pruneReleaseAssets(archive.id);
      expect(dropped).toBe(1);
      // v1 is oldest — file gone; v2/v3 kept
      expect(fs.existsSync(assetPaths[0]!)).toBe(false);
      expect(fs.existsSync(assetPaths[1]!)).toBe(true);
      expect(fs.existsSync(assetPaths[2]!)).toBe(true);

      // Metadata remains for all three
      expect(getArchiveReleasesSorted(archive.id)).toHaveLength(3);

      // Per-repo override to none drops remaining assets
      updateRepo(repo.id, { release_asset_mode: 'none' });
      expect(getArchiveReleaseAssetPolicy(archive.id).mode).toBe('none');
      const dropped2 = pruneReleaseAssets(archive.id);
      expect(dropped2).toBe(2);
      expect(fs.existsSync(assetPaths[1]!)).toBe(false);
      expect(fs.existsSync(assetPaths[2]!)).toBe(false);
    });
  });

  it('shared archive prune uses most permissive member policy', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      warmDb();
      const archive = createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'shared',
        clone_url: 'https://github.com/acme/shared.git',
        mirror_path: path.join(tempDir, 'mirrors', 'github', 'acme', 'shared.git'),
        last_synced_at: null,
        is_private: false,
      });
      const alice = linkUserToArchive(archive.id, {
        owner_id: 'alice',
      });
      linkUserToArchive(archive.id, { owner_id: 'bob' });

      // Alice: last 1; Bob: last 3 → prune keeps 3
      runAsUser('alice', () => {
        updateSettings({
          release_asset_mode: 'last_n',
          release_asset_keep_last: 1,
        });
      });
      runAsUser('bob', () => {
        updateSettings({
          release_asset_mode: 'last_n',
          release_asset_keep_last: 3,
        });
      });

      for (let i = 1; i <= 4; i++) {
        const rel = addRelease({
          archive_id: archive.id,
          tag_name: `v${i}`,
          name: `v${i}`,
          body: null,
          published_at: `2024-0${i}-01T00:00:00Z`,
        });
        const fp = path.join(tempDir, 'shared-assets', `v${i}.bin`);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, 'x');
        addReleaseAsset({
          release_id: rel.id,
          name: `v${i}.bin`,
          content_type: null,
          size: 1,
          file_path: fp,
          download_url: null,
        });
      }

      expect(getArchiveReleaseAssetPolicy(archive.id)).toEqual({
        mode: 'last_n',
        keep_last: 3,
      });
      const dropped = pruneReleaseAssets(archive.id);
      expect(dropped).toBe(1); // only v1

      // If alice sets all, never prune
      runAsUser('alice', () => {
        updateRepo(alice.id, { release_asset_mode: 'all' });
      });
      // recreate v1 asset
      const v1 = getArchiveReleasesSorted(archive.id).find(
        (r) => r.tag_name === 'v1'
      )!;
      const fp = path.join(tempDir, 'shared-assets', 'v1-again.bin');
      fs.writeFileSync(fp, 'y');
      addReleaseAsset({
        release_id: v1.id,
        name: 'v1-again.bin',
        content_type: null,
        size: 1,
        file_path: fp,
        download_url: null,
      });
      expect(getArchiveReleaseAssetPolicy(archive.id).mode).toBe('all');
      expect(pruneReleaseAssets(archive.id)).toBe(0);
      expect(fs.existsSync(fp)).toBe(true);
    });
  });
});
