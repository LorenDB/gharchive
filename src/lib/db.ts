import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

export interface Settings {
  /** Master switch for scheduled archive updates */
  auto_sync_enabled: boolean;
  /**
   * How often to re-sync each repo, in hours.
   * Common values: 1, 6, 12, 24, 48, 168 (weekly)
   */
  sync_interval_hours: number;
  /** Download release asset binaries during sync */
  download_release_assets: boolean;
  /** Skip assets larger than this many MB (0 = no limit) */
  max_asset_size_mb: number;
  /** How many repos to sync in parallel during a scheduled run */
  concurrent_syncs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  auto_sync_enabled: true,
  sync_interval_hours: 24,
  download_release_assets: true,
  max_asset_size_mb: 500,
  concurrent_syncs: 1,
};

interface Data {
  repos: Repo[];
  releases: Release[];
  release_assets: ReleaseAsset[];
  sync_logs: SyncLog[];
  settings: Settings;
}

interface Repo {
  id: number;
  platform: 'github' | 'gitlab';
  owner: string;
  name: string;
  clone_url: string;
  mirror_path: string;
  last_synced_at: string | null;
  created_at: string;
}

interface Release {
  id: number;
  repo_id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  created_at: string;
}

interface ReleaseAsset {
  id: number;
  release_id: number;
  name: string;
  content_type: string | null;
  size: number | null;
  file_path: string | null;
  download_url: string | null;
  created_at: string;
}

interface SyncLog {
  id: number;
  repo_id: number;
  status: 'success' | 'failed';
  message: string | null;
  created_at: string;
}

let data: Data | null = null;
let nextIds: Record<string, number> = {};

function load(): Data {
  if (data) return data;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DB_PATH)) {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    data = {
      repos: [],
      releases: [],
      release_assets: [],
      sync_logs: [],
      settings: { ...DEFAULT_SETTINGS },
    };
  }
  const d = data!;
  for (const key of ['repos', 'releases', 'release_assets', 'sync_logs'] as const) {
    if (!Array.isArray((d as any)[key])) (d as any)[key] = [];
  }
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  nextIds.repos = d.repos.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.releases = d.releases.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.release_assets = d.release_assets.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.sync_logs = d.sync_logs.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  return d;
}

function save() {
  if (data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }
}

export function getDb() {
  return {
    repos: load().repos,
    releases: load().releases,
    releaseAssets: load().release_assets,
    syncLogs: load().sync_logs,
    settings: load().settings,
  };
}

export function getSettings(): Settings {
  return { ...load().settings };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  load();
  data!.settings = { ...data!.settings, ...partial };
  save();
  return { ...data!.settings };
}

export function addRepo(repo: Omit<Repo, 'id' | 'created_at'>): Repo {
  load();
  const now = new Date().toISOString();
  const newRepo: Repo = {
    ...repo,
    id: nextIds.repos++,
    created_at: now,
  };
  data!.repos.push(newRepo);
  save();
  return newRepo;
}

export function updateRepo(id: number, updates: Partial<Pick<Repo, 'last_synced_at'>>) {
  load();
  const idx = data!.repos.findIndex((r) => r.id === id);
  if (idx >= 0) {
    Object.assign(data!.repos[idx], updates);
    save();
  }
}

export function deleteRepo(id: number) {
  load();
  const releaseIds = new Set(
    data!.releases.filter((r) => r.repo_id === id).map((r) => r.id)
  );
  data!.repos = data!.repos.filter((r) => r.id !== id);
  data!.releases = data!.releases.filter((r) => r.repo_id !== id);
  data!.release_assets = data!.release_assets.filter((a) => !releaseIds.has(a.release_id));
  data!.sync_logs = data!.sync_logs.filter((l) => l.repo_id !== id);
  save();
}

export function addRelease(release: Omit<Release, 'id' | 'created_at'>): Release {
  load();
  const now = new Date().toISOString();
  const newRel: Release = { ...release, id: nextIds.releases++, created_at: now };
  data!.releases.push(newRel);
  save();
  return newRel;
}

export function addReleaseAsset(asset: Omit<ReleaseAsset, 'id' | 'created_at'>): ReleaseAsset {
  load();
  const now = new Date().toISOString();
  const newAsset: ReleaseAsset = { ...asset, id: nextIds.release_assets++, created_at: now };
  data!.release_assets.push(newAsset);
  save();
  return newAsset;
}

export function addSyncLog(log: Omit<SyncLog, 'id' | 'created_at'>): SyncLog {
  load();
  const now = new Date().toISOString();
  const newLog: SyncLog = { ...log, id: nextIds.sync_logs++, created_at: now };
  data!.sync_logs.push(newLog);
  save();
  return newLog;
}

export function getReleaseByTag(repoId: number, tagName: string): Release | undefined {
  load();
  return data!.releases.find((r) => r.repo_id === repoId && r.tag_name === tagName);
}

export function getReleaseAssets(releaseId: number): ReleaseAsset[] {
  load();
  return data!.release_assets.filter((a) => a.release_id === releaseId);
}

export function assetExists(releaseId: number, assetName: string): boolean {
  load();
  return data!.release_assets.some(
    (a) => a.release_id === releaseId && a.name === assetName
  );
}

export function tagExists(repoId: number, tagName: string): boolean {
  load();
  return data!.releases.some((r) => r.repo_id === repoId && r.tag_name === tagName);
}
