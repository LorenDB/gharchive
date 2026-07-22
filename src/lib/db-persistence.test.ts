import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsUser, AUTOLOGIN_USER_ID } from '@/lib/user-context';
import {
  createArchive,
  getDb,
  linkUserToArchive,
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
