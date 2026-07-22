import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsUser } from '@/lib/user-context';
import {
  addRelease,
  addReleaseAsset,
  countArchiveMembers,
  createArchive,
  findPublicArchive,
  findRepo,
  getArchiveById,
  getDb,
  getRepoById,
  linkUserToArchive,
  listArchives,
  resetDbForTests,
  unlinkRepo,
  updateArchive,
  updateRepo,
} from '@/lib/db';
import { cloneMirror, getMirrorPath } from '@/lib/git';
import { getReleaseAssetPath } from '@/lib/releases';

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-test-'));
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
    // ignore cleanup races
  }
});

function makeBareMirror(mirrorPath: string) {
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  execSync(`git init --bare "${mirrorPath}"`, { stdio: 'ignore' });
}

describe('path layout', () => {
  it('uses shared path for public mirrors and assets', () => {
    const mirror = getMirrorPath('github', 'acme', 'widget', { isPrivate: false });
    expect(mirror).toBe(
      path.join(tempDir, 'mirrors', 'github', 'acme', 'widget.git')
    );

    const asset = getReleaseAssetPath(
      'github',
      'acme',
      'widget',
      'v1.0.0',
      'app.zip',
      { isPrivate: false }
    );
    expect(asset).toBe(
      path.join(
        tempDir,
        'releases',
        'github',
        'acme',
        'widget',
        'v1.0.0',
        'app.zip'
      )
    );
  });

  it('nests private mirrors and assets under users/{userId}', () => {
    runAsUser('user-a', () => {
      const mirror = getMirrorPath('github', 'acme', 'secret', {
        isPrivate: true,
      });
      expect(mirror).toContain(path.join('mirrors', 'users', 'user-a'));
      expect(mirror.endsWith(path.join('github', 'acme', 'secret.git'))).toBe(
        true
      );

      const asset = getReleaseAssetPath(
        'github',
        'acme',
        'secret',
        'v1',
        'bin',
        { isPrivate: true }
      );
      expect(asset).toContain(path.join('releases', 'users', 'user-a'));
    });
  });
});

describe('cloneMirror reuse', () => {
  it('reuses an existing bare repo instead of wiping it', async () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'keep', {
      isPrivate: false,
    });
    makeBareMirror(mirrorPath);
    const marker = path.join(mirrorPath, 'KEEP_ME');
    fs.writeFileSync(marker, 'yes');

    const result = await cloneMirror(
      'https://github.com/acme/keep.git',
      mirrorPath
    );
    expect(result.reused).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('public archive sharing', () => {
  it('links two users to one public archive with the same mirror_path', () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'shared', {
      isPrivate: false,
    });
    makeBareMirror(mirrorPath);

    const archive = runAsUser('user-a', () =>
      createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'shared',
        clone_url: 'https://github.com/acme/shared.git',
        mirror_path: mirrorPath,
        last_synced_at: null,
        is_private: false,
      })
    );

    const membershipA = runAsUser('user-a', () =>
      linkUserToArchive(archive.id, { from_star: true })
    );
    const membershipB = runAsUser('user-b', () =>
      linkUserToArchive(archive.id, { from_owned: true })
    );

    expect(membershipA.archive_id).toBe(archive.id);
    expect(membershipB.archive_id).toBe(archive.id);
    expect(membershipA.id).not.toBe(membershipB.id);
    expect(membershipA.mirror_path).toBe(membershipB.mirror_path);
    expect(countArchiveMembers(archive.id)).toBe(2);

    // findPublicArchive is global
    const found = findPublicArchive('github', 'acme', 'shared');
    expect(found?.id).toBe(archive.id);

    // Each user only sees their membership
    runAsUser('user-a', () => {
      const { repos } = getDb();
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe(membershipA.id);
      expect(repos[0].from_star).toBe(true);
      expect(findRepo('github', 'acme', 'shared')?.id).toBe(membershipA.id);
    });
    runAsUser('user-b', () => {
      const { repos } = getDb();
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe(membershipB.id);
      expect(repos[0].from_owned).toBe(true);
    });
  });

  it('shares release rows across members via archive_id', () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'rel', {
      isPrivate: false,
    });
    makeBareMirror(mirrorPath);

    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'rel',
      clone_url: 'https://github.com/acme/rel.git',
      mirror_path: mirrorPath,
      last_synced_at: null,
      is_private: false,
    });

    runAsUser('user-a', () => linkUserToArchive(archive.id));
    runAsUser('user-b', () => linkUserToArchive(archive.id));

    const release = addRelease({
      archive_id: archive.id,
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      body: 'notes',
      published_at: '2026-01-01T00:00:00Z',
    });
    const assetPath = getReleaseAssetPath(
      'github',
      'acme',
      'rel',
      'v1.0.0',
      'app.zip',
      { isPrivate: false }
    );
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'zip-bytes');
    addReleaseAsset({
      release_id: release.id,
      name: 'app.zip',
      content_type: 'application/zip',
      size: 9,
      file_path: assetPath,
      download_url: null,
    });

    for (const uid of ['user-a', 'user-b']) {
      runAsUser(uid, () => {
        const { releases, releaseAssets } = getDb();
        expect(releases).toHaveLength(1);
        expect(releases[0].archive_id).toBe(archive.id);
        expect(releases[0].tag_name).toBe('v1.0.0');
        expect(releaseAssets).toHaveLength(1);
        expect(releaseAssets[0].file_path).toBe(assetPath);
      });
    }
  });

  it('updates remote meta on the shared archive for all members', () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'meta', {
      isPrivate: false,
    });
    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'meta',
      clone_url: 'https://github.com/acme/meta.git',
      mirror_path: mirrorPath,
      last_synced_at: null,
      is_private: false,
    });
    const a = runAsUser('user-a', () => linkUserToArchive(archive.id));
    const b = runAsUser('user-b', () => linkUserToArchive(archive.id));

    runAsUser('user-a', () => {
      updateRepo(a.id, {
        remote_description: 'hello world',
        stargazers_count: 42,
        last_synced_at: '2026-06-01T00:00:00Z',
      });
    });

    runAsUser('user-b', () => {
      const repo = getRepoById(b.id)!;
      expect(repo.remote_description).toBe('hello world');
      expect(repo.stargazers_count).toBe(42);
      expect(repo.last_synced_at).toBe('2026-06-01T00:00:00Z');
    });

    // local_description stays per-membership
    runAsUser('user-a', () => {
      updateRepo(a.id, { local_description: 'my notes' });
    });
    runAsUser('user-a', () => {
      expect(getRepoById(a.id)!.local_description).toBe('my notes');
    });
    runAsUser('user-b', () => {
      expect(getRepoById(b.id)!.local_description).toBeNull();
    });
  });
});

describe('private archives are never shared', () => {
  it('does not match private archives via findPublicArchive', () => {
    const pathA = getMirrorPath('github', 'acme', 'secret', {
      isPrivate: true,
      userId: 'user-a',
    });
    const pathB = getMirrorPath('github', 'acme', 'secret', {
      isPrivate: true,
      userId: 'user-b',
    });
    expect(pathA).not.toBe(pathB);

    const archA = runAsUser('user-a', () =>
      createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'secret',
        clone_url: 'https://github.com/acme/secret.git',
        mirror_path: pathA,
        last_synced_at: null,
        is_private: true,
      })
    );
    const archB = runAsUser('user-b', () =>
      createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'secret',
        clone_url: 'https://github.com/acme/secret.git',
        mirror_path: pathB,
        last_synced_at: null,
        is_private: true,
      })
    );

    expect(archA.id).not.toBe(archB.id);
    expect(findPublicArchive('github', 'acme', 'secret')).toBeUndefined();
    expect(countArchiveMembers(archA.id)).toBe(0);
  });
});

describe('unlinkRepo refcounting', () => {
  it('keeps archive and mirror when other members remain', () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'multi', {
      isPrivate: false,
    });
    makeBareMirror(mirrorPath);

    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'multi',
      clone_url: 'https://github.com/acme/multi.git',
      mirror_path: mirrorPath,
      last_synced_at: null,
      is_private: false,
    });
    const a = runAsUser('user-a', () => linkUserToArchive(archive.id));
    const b = runAsUser('user-b', () => linkUserToArchive(archive.id));

    const assetPath = path.join(tempDir, 'releases', 'file.bin');
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'data');
    const rel = addRelease({
      archive_id: archive.id,
      tag_name: 'v1',
      name: null,
      body: null,
      published_at: null,
    });
    addReleaseAsset({
      release_id: rel.id,
      name: 'file.bin',
      content_type: null,
      size: 4,
      file_path: assetPath,
      download_url: null,
    });

    const result = runAsUser('user-a', () => unlinkRepo(a.id));
    expect(result.unlinked).toBe(true);
    expect(result.archiveDeleted).toBe(false);
    expect(result.mirrorPath).toBeNull();
    expect(result.assetPaths).toEqual([]);

    expect(getArchiveById(archive.id)).toBeDefined();
    expect(countArchiveMembers(archive.id)).toBe(1);
    expect(fs.existsSync(mirrorPath)).toBe(true);
    expect(fs.existsSync(assetPath)).toBe(true);

    runAsUser('user-a', () => {
      expect(getRepoById(a.id)).toBeUndefined();
      expect(getDb().repos).toHaveLength(0);
    });
    runAsUser('user-b', () => {
      expect(getRepoById(b.id)).toBeDefined();
      expect(getDb().releases).toHaveLength(1);
    });
  });

  it('deletes archive, releases, and reports paths when last member unlinks', () => {
    const mirrorPath = getMirrorPath('github', 'acme', 'solo', {
      isPrivate: false,
    });
    makeBareMirror(mirrorPath);

    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'solo',
      clone_url: 'https://github.com/acme/solo.git',
      mirror_path: mirrorPath,
      last_synced_at: null,
      is_private: false,
    });
    const m = runAsUser('user-a', () => linkUserToArchive(archive.id));

    const assetPath = path.join(tempDir, 'asset-only.bin');
    fs.writeFileSync(assetPath, 'x');
    const rel = addRelease({
      archive_id: archive.id,
      tag_name: 'v9',
      name: null,
      body: null,
      published_at: null,
    });
    addReleaseAsset({
      release_id: rel.id,
      name: 'asset-only.bin',
      content_type: null,
      size: 1,
      file_path: assetPath,
      download_url: null,
    });

    const result = runAsUser('user-a', () => unlinkRepo(m.id));
    expect(result.unlinked).toBe(true);
    expect(result.archiveDeleted).toBe(true);
    expect(result.mirrorPath).toBe(mirrorPath);
    expect(result.assetPaths).toEqual([assetPath]);

    expect(getArchiveById(archive.id)).toBeUndefined();
    expect(listArchives()).toHaveLength(0);
    expect(countArchiveMembers(archive.id)).toBe(0);

    // DB rows gone; files left for caller (DELETE handler) to remove
    runAsUser('user-a', () => {
      expect(getDb().releases).toHaveLength(0);
      expect(getDb().releaseAssets).toHaveLength(0);
    });
  });

  it('returns unlinked=false for missing or other-user membership', () => {
    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'x',
      clone_url: 'https://github.com/acme/x.git',
      mirror_path: '/tmp/x.git',
      last_synced_at: null,
      is_private: false,
    });
    const m = runAsUser('user-a', () => linkUserToArchive(archive.id));

    const missing = runAsUser('user-a', () => unlinkRepo(99999));
    expect(missing.unlinked).toBe(false);

    const wrongUser = runAsUser('user-b', () => unlinkRepo(m.id));
    expect(wrongUser.unlinked).toBe(false);
    expect(countArchiveMembers(archive.id)).toBe(1);
  });
});

describe('schema v2 → v3 migration', () => {
  it('merges public duplicates into one archive and isolates private rows', () => {
    // Write a legacy v2-style db.json then reload
    const legacy = {
      schema_version: 2,
      users: [],
      legacy_claimed_by: null,
      settings_by_user: {},
      github_accounts: {},
      lists: [],
      repo_lists: [],
      sync_logs: [],
      archives: [],
      repos: [
        {
          id: 1,
          owner_id: 'alice',
          platform: 'github',
          owner: 'acme',
          name: 'public-app',
          clone_url: 'https://github.com/acme/public-app.git',
          mirror_path: path.join(tempDir, 'mirrors', 'github', 'acme', 'public-app.git'),
          last_synced_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
          is_private: false,
          remote_description: 'from alice',
        },
        {
          id: 2,
          owner_id: 'bob',
          platform: 'github',
          owner: 'acme',
          name: 'public-app',
          clone_url: 'https://github.com/acme/public-app.git',
          mirror_path: path.join(
            tempDir,
            'mirrors',
            'users',
            'bob',
            'github',
            'acme',
            'public-app.git'
          ),
          last_synced_at: '2026-01-02T00:00:00Z',
          created_at: '2026-01-02T00:00:00Z',
          is_private: false,
          remote_description: 'from bob',
        },
        {
          id: 3,
          owner_id: 'alice',
          platform: 'github',
          owner: 'acme',
          name: 'private-app',
          clone_url: 'https://github.com/acme/private-app.git',
          mirror_path: path.join(
            tempDir,
            'mirrors',
            'users',
            'alice',
            'github',
            'acme',
            'private-app.git'
          ),
          last_synced_at: null,
          created_at: '2026-01-03T00:00:00Z',
          is_private: true,
        },
        {
          id: 4,
          owner_id: 'bob',
          platform: 'github',
          owner: 'acme',
          name: 'private-app',
          clone_url: 'https://github.com/acme/private-app.git',
          mirror_path: path.join(
            tempDir,
            'mirrors',
            'users',
            'bob',
            'github',
            'acme',
            'private-app.git'
          ),
          last_synced_at: null,
          created_at: '2026-01-04T00:00:00Z',
          is_private: true,
        },
      ],
      releases: [
        {
          id: 10,
          repo_id: 1,
          tag_name: 'v1',
          name: 'v1',
          body: null,
          published_at: null,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 11,
          repo_id: 2,
          tag_name: 'v1',
          name: 'v1-dup',
          body: null,
          published_at: null,
          created_at: '2026-01-02T00:00:00Z',
        },
        {
          id: 12,
          repo_id: 3,
          tag_name: 'secret-v1',
          name: null,
          body: null,
          published_at: null,
          created_at: '2026-01-03T00:00:00Z',
        },
      ],
      release_assets: [
        {
          id: 100,
          release_id: 10,
          name: 'a.zip',
          content_type: null,
          size: 1,
          file_path: null,
          download_url: null,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 101,
          release_id: 11,
          name: 'b.zip',
          content_type: null,
          size: 1,
          file_path: '/tmp/b.zip',
          download_url: null,
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
    };

    // Primary for public-app should prefer bob's more recent sync; create that tree larger
    makeBareMirror(legacy.repos[0].mirror_path);
    makeBareMirror(legacy.repos[1].mirror_path);
    // Make bob's mirror larger so migration ranks it first
    fs.writeFileSync(
      path.join(legacy.repos[1].mirror_path, 'objects', 'big'),
      'x'.repeat(1000)
    );

    fs.writeFileSync(
      path.join(tempDir, 'db.json'),
      JSON.stringify(legacy, null, 2)
    );
    resetDbForTests();

    // Trigger load/migrate via any db call
    const archives = listArchives();
    expect(archives.length).toBe(3); // 1 shared public + 2 private

    const publicArch = findPublicArchive('github', 'acme', 'public-app');
    expect(publicArch).toBeDefined();
    expect(countArchiveMembers(publicArch!.id)).toBe(2);
    expect(publicArch!.is_private).toBeFalsy();

    const privateOnes = archives.filter((a) => a.is_private);
    expect(privateOnes).toHaveLength(2);
    expect(privateOnes.every((a) => a.name === 'private-app')).toBe(true);

    // Releases for public: one v1 tag, prefer the one with file_path (repo 2 / release 11)
    runAsUser('alice', () => {
      const { releases, releaseAssets, repos } = getDb();
      expect(repos.map((r) => r.name).sort()).toEqual([
        'private-app',
        'public-app',
      ]);
      const pubReleases = releases.filter(
        (r) => r.archive_id === publicArch!.id
      );
      expect(pubReleases).toHaveLength(1);
      expect(pubReleases[0].tag_name).toBe('v1');
      // Richest release kept (has file_path on asset)
      const assets = releaseAssets.filter(
        (a) => a.release_id === pubReleases[0].id
      );
      expect(assets).toHaveLength(1);
      expect(assets[0].file_path).toBe('/tmp/b.zip');
    });

    runAsUser('bob', () => {
      const { repos, releases } = getDb();
      expect(repos).toHaveLength(2);
      const privateRepo = repos.find((r) => r.name === 'private-app')!;
      expect(privateRepo.is_private).toBe(true);
      // Bob's private archive should not share alice's secret release unless same archive
      const alicePrivate = privateOnes.find((a) =>
        a.mirror_path.includes(`${path.sep}alice${path.sep}`)
      );
      const bobPrivate = privateOnes.find((a) =>
        a.mirror_path.includes(`${path.sep}bob${path.sep}`)
      );
      expect(alicePrivate?.id).not.toBe(bobPrivate?.id);
      expect(privateRepo.archive_id).toBe(bobPrivate!.id);
      expect(
        releases.filter((r) => r.archive_id === bobPrivate!.id)
      ).toHaveLength(0);
    });

    // Persisted schema version
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'db.json'), 'utf8')
    );
    expect(onDisk.schema_version).toBe(4);
    expect(onDisk.repos.every((r: { archive_id: number }) => r.archive_id)).toBe(
      true
    );
    expect(
      onDisk.releases.every(
        (r: { archive_id?: number; repo_id?: number }) =>
          r.archive_id != null && r.repo_id == null
      )
    ).toBe(true);
  });
});

describe('updateArchive privacy flag', () => {
  it('keeps archive out of public lookup after marking private', () => {
    const archive = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'flip',
      clone_url: 'https://github.com/acme/flip.git',
      mirror_path: '/tmp/flip.git',
      last_synced_at: null,
      is_private: false,
    });
    expect(findPublicArchive('github', 'acme', 'flip')?.id).toBe(archive.id);
    updateArchive(archive.id, { is_private: true });
    expect(findPublicArchive('github', 'acme', 'flip')).toBeUndefined();
  });
});
