import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsUser, AUTOLOGIN_USER_ID } from '@/lib/user-context';
import {
  createArchive,
  ensureAppUser,
  getDb,
  linkUserToArchive,
  getUserStorageDetail,
  listUsersWithUsage,
  resetDbForTests,
  updateSettings,
  warmDb,
} from '@/lib/db';

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-db-'));
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

function dbPath() {
  return path.join(tempDir, 'db.json');
}

describe('db atomic persistence', () => {
  it('writes via rename and keeps a .bak after save', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      updateSettings({ auto_sync_enabled: false });
    });

    expect(fs.existsSync(dbPath())).toBe(true);
    expect(fs.existsSync(dbPath() + '.bak')).toBe(true);
    expect(fs.existsSync(dbPath() + '.tmp')).toBe(false);

    const primary = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
    const bak = JSON.parse(fs.readFileSync(dbPath() + '.bak', 'utf8'));
    expect(primary.settings_by_user[AUTOLOGIN_USER_ID].auto_sync_enabled).toBe(
      false
    );
    expect(bak.settings_by_user[AUTOLOGIN_USER_ID].auto_sync_enabled).toBe(
      false
    );
  });

  it('restores from .bak when primary JSON is truncated', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const archive = createArchive({
        platform: 'github',
        owner: 'acme',
        name: 'widget',
        clone_url: 'https://github.com/acme/widget.git',
        mirror_path: path.join(tempDir, 'mirrors', 'github', 'acme', 'widget.git'),
        last_synced_at: null,
        is_private: false,
      });
      linkUserToArchive(archive.id, { from_star: true });
      updateSettings({ sync_interval_hours: 6 });
    });

    // Snapshot good bak, then corrupt the primary mid-string (classic crash mid-write)
    const good = fs.readFileSync(dbPath(), 'utf8');
    fs.writeFileSync(dbPath() + '.bak', good);
    fs.writeFileSync(dbPath(), good.slice(0, Math.floor(good.length / 2)));

    resetDbForTests();
    warmDb();

    const repos = runAsUser(AUTOLOGIN_USER_ID, () => getDb().repos);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('widget');

    // Primary should have been rewritten from bak
    const recovered = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
    expect(recovered.archives).toHaveLength(1);
  });

  it('quarantines corrupt primary and starts empty when no bak exists', () => {
    fs.writeFileSync(dbPath(), '{"repos":[{"broken":"unterminated]');

    resetDbForTests();
    warmDb();

    const repos = runAsUser(AUTOLOGIN_USER_ID, () => getDb().repos);
    expect(repos).toHaveLength(0);

    const corrupt = fs
      .readdirSync(tempDir)
      .filter((f) => f.startsWith('db.json.corrupt-'));
    expect(corrupt.length).toBe(1);

    // Fresh primary is valid
    expect(() =>
      JSON.parse(fs.readFileSync(dbPath(), 'utf8'))
    ).not.toThrow();
  });

  it('repairs gitlab archives that were stored as github (schema v4)', () => {
    const wrongMirror = path.join(
      tempDir,
      'mirrors',
      'github',
      'Mr_Goldberg',
      'goldberg_emulator.git'
    );
    const rightMirror = path.join(
      tempDir,
      'mirrors',
      'gitlab',
      'Mr_Goldberg',
      'goldberg_emulator.git'
    );
    fs.mkdirSync(wrongMirror, { recursive: true });
    fs.writeFileSync(path.join(wrongMirror, 'HEAD'), 'ref: refs/heads/main\n');

    fs.writeFileSync(
      dbPath(),
      JSON.stringify({
        schema_version: 3,
        users: [],
        legacy_claimed_by: null,
        archives: [
          {
            id: 1,
            platform: 'github',
            owner: 'Mr_Goldberg',
            name: 'goldberg_emulator',
            clone_url: 'https://gitlab.com/Mr_Goldberg/goldberg_emulator',
            mirror_path: wrongMirror,
            last_synced_at: null,
            is_private: false,
          },
        ],
        repos: [
          {
            id: 1,
            owner_id: AUTOLOGIN_USER_ID,
            archive_id: 1,
            created_at: new Date().toISOString(),
          },
        ],
        releases: [],
        release_assets: [],
        sync_logs: [],
        settings_by_user: {},
        lists: [],
        repo_lists: [],
        github_accounts: {},
      })
    );

    resetDbForTests();
    warmDb();

    const repos = runAsUser(AUTOLOGIN_USER_ID, () => getDb().repos);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.platform).toBe('gitlab');
    expect(repos[0]!.mirror_path).toBe(rightMirror);
    expect(fs.existsSync(rightMirror)).toBe(true);
    expect(fs.existsSync(wrongMirror)).toBe(false);

    const onDisk = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
    expect(onDisk.schema_version).toBe(4);
    expect(onDisk.archives[0].platform).toBe('gitlab');
  });
});

describe('listUsersWithUsage', () => {
  it('splits shared public archive storage and attributes private fully', () => {
    const publicMirror = path.join(
      tempDir,
      'mirrors',
      'github',
      'acme',
      'shared.git'
    );
    const privateMirror = path.join(
      tempDir,
      'mirrors',
      'users',
      'alice',
      'github',
      'acme',
      'secret.git'
    );
    fs.mkdirSync(publicMirror, { recursive: true });
    fs.mkdirSync(privateMirror, { recursive: true });
    fs.writeFileSync(path.join(publicMirror, 'blob'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(privateMirror, 'blob'), 'y'.repeat(400));

    ensureAppUser({
      id: 'alice',
      username: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      role: 'user',
      groups: [],
    });
    ensureAppUser({
      id: 'bob',
      username: 'bob',
      email: null,
      name: null,
      role: 'user',
      groups: [],
    });

    const publicArch = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'shared',
      clone_url: 'https://github.com/acme/shared.git',
      mirror_path: publicMirror,
      last_synced_at: null,
      is_private: false,
    });
    const privateArch = createArchive({
      platform: 'github',
      owner: 'acme',
      name: 'secret',
      clone_url: 'https://github.com/acme/secret.git',
      mirror_path: privateMirror,
      last_synced_at: null,
      is_private: true,
    });

    runAsUser('alice', () => {
      linkUserToArchive(publicArch.id);
      linkUserToArchive(privateArch.id);
    });
    runAsUser('bob', () => {
      linkUserToArchive(publicArch.id);
    });

    const users = listUsersWithUsage();
    const alice = users.find((u) => u.id === 'alice');
    const bob = users.find((u) => u.id === 'bob');

    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    expect(alice!.registered).toBe(true);
    expect(alice!.repo_count).toBe(2);
    expect(alice!.private_repo_count).toBe(1);
    expect(bob!.repo_count).toBe(1);
    expect(bob!.private_repo_count).toBe(0);

    // Public 1000 bytes / 2 members = 500 each; alice also gets private 400
    expect(alice!.storage_bytes).toBe(900);
    expect(bob!.storage_bytes).toBe(500);

    const aliceDetail = getUserStorageDetail('alice', 5);
    expect(aliceDetail.total_bytes).toBe(900);
    expect(aliceDetail.repo_count).toBe(2);
    expect(aliceDetail.private_repo_count).toBe(1);
    expect(aliceDetail.largest_repos).toHaveLength(2);
    // Private 400 attributed fully ranks below shared half of 1000 (=500)
    expect(aliceDetail.largest_repos[0]!.name).toBe('shared');
    expect(aliceDetail.largest_repos[0]!.attributed_bytes).toBe(500);
    expect(aliceDetail.largest_repos[0]!.member_count).toBe(2);
    expect(aliceDetail.largest_repos[1]!.name).toBe('secret');
    expect(aliceDetail.largest_repos[1]!.attributed_bytes).toBe(400);
    expect(aliceDetail.other_repo_count).toBe(0);

    const bobDetail = getUserStorageDetail('bob', 1);
    expect(bobDetail.total_bytes).toBe(500);
    expect(bobDetail.largest_repos).toHaveLength(1);
    expect(bobDetail.other_repo_count).toBe(0);
  });

  it('resolves display username when stored username equals OIDC sub', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    ensureAppUser({
      id: uuid,
      username: uuid,
      email: 'sso-user@example.com',
      name: 'SSO User',
      role: 'user',
      groups: [],
    });

    const users = listUsersWithUsage();
    const row = users.find((u) => u.id === uuid);
    expect(row).toBeTruthy();
    expect(row!.username).toBe('sso-user');
    expect(row!.email).toBe('sso-user@example.com');
    expect(row!.name).toBe('SSO User');
  });

  it('limits largest_repos and rolls the rest into other_bytes', () => {
    const sizes = [5000, 4000, 3000, 2000, 1000, 500];
    for (let i = 0; i < sizes.length; i++) {
      const mirror = path.join(
        tempDir,
        'mirrors',
        'github',
        'org',
        `repo${i}.git`
      );
      fs.mkdirSync(mirror, { recursive: true });
      fs.writeFileSync(path.join(mirror, 'blob'), 'z'.repeat(sizes[i]!));
      const arch = createArchive({
        platform: 'github',
        owner: 'org',
        name: `repo${i}`,
        clone_url: `https://github.com/org/repo${i}.git`,
        mirror_path: mirror,
        last_synced_at: null,
        is_private: false,
      });
      runAsUser('solo', () => linkUserToArchive(arch.id));
    }

    const detail = getUserStorageDetail('solo', 5);
    expect(detail.repo_count).toBe(6);
    expect(detail.largest_repos).toHaveLength(5);
    expect(detail.largest_repos.map((r) => r.name)).toEqual([
      'repo0',
      'repo1',
      'repo2',
      'repo3',
      'repo4',
    ]);
    expect(detail.other_repo_count).toBe(1);
    expect(detail.other_bytes).toBe(500);
    expect(detail.total_bytes).toBe(5000 + 4000 + 3000 + 2000 + 1000 + 500);
  });
});
