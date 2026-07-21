import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

export interface Settings {
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  download_release_assets: boolean;
  max_asset_size_mb: number;
  concurrent_syncs: number;
  /** Scan linked account stars on a schedule */
  auto_scan_stars_enabled: boolean;
  /** When scanning stars, auto-archive any not yet mirrored */
  auto_import_stars_enabled: boolean;
  /** Scan repositories owned by the linked account */
  auto_scan_owned_enabled: boolean;
  /** When scanning owned repos, auto-archive any not yet mirrored */
  auto_import_owned_enabled: boolean;
  /** How often to run GitHub star/owned scans (hours) */
  github_scan_interval_hours: number;
  /** Include forks when scanning owned repositories */
  auto_import_owned_include_forks: boolean;
  /** Include private repos when scanning owned repositories */
  auto_import_owned_include_private: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  auto_sync_enabled: true,
  sync_interval_hours: 24,
  download_release_assets: true,
  max_asset_size_mb: 500,
  concurrent_syncs: 1,
  auto_scan_stars_enabled: false,
  auto_import_stars_enabled: false,
  auto_scan_owned_enabled: false,
  auto_import_owned_enabled: false,
  github_scan_interval_hours: 24,
  auto_import_owned_include_forks: false,
  auto_import_owned_include_private: true,
};

export interface GithubAccount {
  username: string;
  /** Personal access token (classic or fine-grained). Stored in local data only. */
  token: string;
  linked_at: string;
  last_stars_import_at: string | null;
  last_stars_scan_at: string | null;
  last_owned_scan_at: string | null;
  last_owned_import_at: string | null;
}

export interface List {
  id: number;
  name: string;
  description: string | null;
  /** Tailwind-friendly hex color for badges */
  color: string;
  source: 'local' | 'github';
  /** GitHub GraphQL UserList node id when source=github */
  github_list_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepoList {
  repo_id: number;
  list_id: number;
}

export interface Repo {
  id: number;
  platform: 'github' | 'gitlab';
  owner: string;
  name: string;
  clone_url: string;
  mirror_path: string;
  last_synced_at: string | null;
  created_at: string;
  /** True if added via GitHub stars import */
  from_star?: boolean;
  /** True if added via owned-repos import */
  from_owned?: boolean;
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

interface Data {
  repos: Repo[];
  releases: Release[];
  release_assets: ReleaseAsset[];
  sync_logs: SyncLog[];
  settings: Settings;
  lists: List[];
  repo_lists: RepoList[];
  github_account: GithubAccount | null;
}

export const LIST_COLORS = [
  '#e8b44a', // amber
  '#5ecf9a', // mint
  '#6ea8fe', // blue
  '#c084fc', // purple
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#f97316', // orange
  '#a3e635', // lime
  '#38bdf8', // sky
  '#f472b6', // pink
];

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
    data = emptyData();
  }
  const d = data!;
  for (const key of [
    'repos',
    'releases',
    'release_assets',
    'sync_logs',
    'lists',
    'repo_lists',
  ] as const) {
    if (!Array.isArray((d as any)[key])) (d as any)[key] = [];
  }
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  if (d.github_account === undefined) d.github_account = null;

  nextIds.repos = d.repos.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.releases = d.releases.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.release_assets =
    d.release_assets.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.sync_logs = d.sync_logs.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.lists = d.lists.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  return d;
}

function emptyData(): Data {
  return {
    repos: [],
    releases: [],
    release_assets: [],
    sync_logs: [],
    settings: { ...DEFAULT_SETTINGS },
    lists: [],
    repo_lists: [],
    github_account: null,
  };
}

function save() {
  if (data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }
}

export function getDb() {
  const d = load();
  return {
    repos: d.repos,
    releases: d.releases,
    releaseAssets: d.release_assets,
    syncLogs: d.sync_logs,
    settings: d.settings,
    lists: d.lists,
    repoLists: d.repo_lists,
    githubAccount: d.github_account,
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

// ── GitHub account ──────────────────────────────────────────────

export function getGithubAccount(): GithubAccount | null {
  const acc = load().github_account;
  return acc ? { ...acc } : null;
}

/** Safe view without the raw token */
export function getGithubAccountPublic(): {
  username: string;
  linked_at: string;
  last_stars_import_at: string | null;
  last_stars_scan_at: string | null;
  last_owned_scan_at: string | null;
  last_owned_import_at: string | null;
  has_token: boolean;
} | null {
  const acc = load().github_account;
  if (!acc) return null;
  return {
    username: acc.username,
    linked_at: acc.linked_at,
    last_stars_import_at: acc.last_stars_import_at ?? null,
    last_stars_scan_at: acc.last_stars_scan_at ?? null,
    last_owned_scan_at: acc.last_owned_scan_at ?? null,
    last_owned_import_at: acc.last_owned_import_at ?? null,
    has_token: Boolean(acc.token),
  };
}

export function setGithubAccount(account: GithubAccount): GithubAccount {
  load();
  data!.github_account = {
    ...account,
    last_stars_scan_at: account.last_stars_scan_at ?? null,
    last_owned_scan_at: account.last_owned_scan_at ?? null,
    last_owned_import_at: account.last_owned_import_at ?? null,
    last_stars_import_at: account.last_stars_import_at ?? null,
  };
  save();
  return { ...data!.github_account! };
}

export function clearGithubAccount() {
  load();
  data!.github_account = null;
  save();
}

export function touchGithubImport() {
  load();
  if (data!.github_account) {
    data!.github_account.last_stars_import_at = new Date().toISOString();
    save();
  }
}

export function touchGithubScan(
  kind: 'stars' | 'owned',
  opts: { imported?: boolean } = {}
) {
  load();
  if (!data!.github_account) return;
  const now = new Date().toISOString();
  if (kind === 'stars') {
    data!.github_account.last_stars_scan_at = now;
    if (opts.imported) data!.github_account.last_stars_import_at = now;
  } else {
    data!.github_account.last_owned_scan_at = now;
    if (opts.imported) data!.github_account.last_owned_import_at = now;
  }
  save();
}

/** Prefer linked account token, then env GITHUB_TOKEN */
export function getGithubToken(): string | undefined {
  const acc = load().github_account;
  if (acc?.token) return acc.token;
  return process.env.GITHUB_TOKEN || undefined;
}

// ── Repos ───────────────────────────────────────────────────────

export function addRepo(
  repo: Omit<Repo, 'id' | 'created_at'> & { from_star?: boolean }
): Repo {
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

export function findRepo(
  platform: string,
  owner: string,
  name: string
): Repo | undefined {
  load();
  return data!.repos.find(
    (r) => r.platform === platform && r.owner === owner && r.name === name
  );
}

export function updateRepo(
  id: number,
  updates: Partial<Pick<Repo, 'last_synced_at' | 'from_star' | 'from_owned'>>
) {
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
  data!.release_assets = data!.release_assets.filter(
    (a) => !releaseIds.has(a.release_id)
  );
  data!.sync_logs = data!.sync_logs.filter((l) => l.repo_id !== id);
  data!.repo_lists = data!.repo_lists.filter((rl) => rl.repo_id !== id);
  save();
}

// ── Lists ───────────────────────────────────────────────────────

export function getLists(): List[] {
  return [...load().lists].sort((a, b) => a.name.localeCompare(b.name));
}

export function getList(id: number): List | undefined {
  return load().lists.find((l) => l.id === id);
}

export function getListByGithubId(githubListId: string): List | undefined {
  return load().lists.find((l) => l.github_list_id === githubListId);
}

export function getListByName(name: string): List | undefined {
  const lower = name.toLowerCase();
  return load().lists.find((l) => l.name.toLowerCase() === lower);
}

export function addList(
  input: Omit<List, 'id' | 'created_at' | 'updated_at'>
): List {
  load();
  const now = new Date().toISOString();
  const list: List = {
    ...input,
    id: nextIds.lists++,
    created_at: now,
    updated_at: now,
  };
  data!.lists.push(list);
  save();
  return list;
}

/** Get or create a local system list by exact name. */
export function ensureLocalList(
  name: string,
  description: string | null,
  color: string
): List {
  const existing = getListByName(name);
  if (existing) return existing;
  return addList({
    name,
    description,
    color,
    source: 'local',
    github_list_id: null,
  });
}

export function updateList(
  id: number,
  updates: Partial<
    Pick<List, 'name' | 'description' | 'color' | 'github_list_id' | 'source'>
  >
): List | null {
  load();
  const idx = data!.lists.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  Object.assign(data!.lists[idx], updates, {
    updated_at: new Date().toISOString(),
  });
  save();
  return { ...data!.lists[idx] };
}

export function deleteList(id: number) {
  load();
  data!.lists = data!.lists.filter((l) => l.id !== id);
  data!.repo_lists = data!.repo_lists.filter((rl) => rl.list_id !== id);
  save();
}

export function getRepoListIds(repoId: number): number[] {
  return load()
    .repo_lists.filter((rl) => rl.repo_id === repoId)
    .map((rl) => rl.list_id);
}

export function getRepoLists(repoId: number): List[] {
  const ids = new Set(getRepoListIds(repoId));
  return load().lists.filter((l) => ids.has(l.id));
}

export function setRepoLists(repoId: number, listIds: number[]) {
  load();
  data!.repo_lists = data!.repo_lists.filter((rl) => rl.repo_id !== repoId);
  const unique = [...new Set(listIds)];
  for (const list_id of unique) {
    if (data!.lists.some((l) => l.id === list_id)) {
      data!.repo_lists.push({ repo_id: repoId, list_id });
    }
  }
  save();
}

export function addRepoToList(repoId: number, listId: number) {
  load();
  const exists = data!.repo_lists.some(
    (rl) => rl.repo_id === repoId && rl.list_id === listId
  );
  if (!exists && data!.lists.some((l) => l.id === listId)) {
    data!.repo_lists.push({ repo_id: repoId, list_id: listId });
    save();
  }
}

export function removeRepoFromList(repoId: number, listId: number) {
  load();
  data!.repo_lists = data!.repo_lists.filter(
    (rl) => !(rl.repo_id === repoId && rl.list_id === listId)
  );
  save();
}

export function getListRepoIds(listId: number): number[] {
  return load()
    .repo_lists.filter((rl) => rl.list_id === listId)
    .map((rl) => rl.repo_id);
}

export function getListCounts(): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const rl of load().repo_lists) {
    counts[rl.list_id] = (counts[rl.list_id] || 0) + 1;
  }
  return counts;
}

/** Upsert a GitHub-sourced list by github_list_id (or name fallback). */
export function upsertGithubList(input: {
  github_list_id: string;
  name: string;
  description: string | null;
  color?: string;
}): List {
  load();
  const existing =
    getListByGithubId(input.github_list_id) || getListByName(input.name);
  if (existing) {
    return (
      updateList(existing.id, {
        name: input.name,
        description: input.description,
        github_list_id: input.github_list_id,
        source: 'github',
        ...(input.color ? { color: input.color } : {}),
      }) || existing
    );
  }
  const used = data!.lists.length;
  return addList({
    name: input.name,
    description: input.description,
    color: input.color || LIST_COLORS[used % LIST_COLORS.length],
    source: 'github',
    github_list_id: input.github_list_id,
  });
}

// ── Releases / sync logs ────────────────────────────────────────

export function addRelease(release: Omit<Release, 'id' | 'created_at'>): Release {
  load();
  const now = new Date().toISOString();
  const newRel: Release = { ...release, id: nextIds.releases++, created_at: now };
  data!.releases.push(newRel);
  save();
  return newRel;
}

export function addReleaseAsset(
  asset: Omit<ReleaseAsset, 'id' | 'created_at'>
): ReleaseAsset {
  load();
  const now = new Date().toISOString();
  const newAsset: ReleaseAsset = {
    ...asset,
    id: nextIds.release_assets++,
    created_at: now,
  };
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

export function getReleaseByTag(
  repoId: number,
  tagName: string
): Release | undefined {
  load();
  return data!.releases.find(
    (r) => r.repo_id === repoId && r.tag_name === tagName
  );
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
  return data!.releases.some(
    (r) => r.repo_id === repoId && r.tag_name === tagName
  );
}
