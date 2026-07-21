import path from 'path';
import fs from 'fs';
import {
  AUTOLOGIN_USER_ID,
  getRequiredUserId,
  tryGetUserId,
} from '@/lib/user-context';
import type { SessionUser } from '@/lib/session';

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
  /** Dynamically adjust job concurrency based on available memory */
  memory_aware_enabled: boolean;
  /** Minimum free memory in MB before starting new jobs */
  min_free_memory_mb: number;
  /** Maximum allowed memory usage ratio (0-1) before deferring work */
  max_memory_usage_ratio: number;
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
  memory_aware_enabled: true,
  min_free_memory_mb: 256,
  max_memory_usage_ratio: 0.8,
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

export interface AppUser {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  created_at: string;
  last_login_at: string;
}

export interface List {
  id: number;
  /** Owning app user id (OIDC sub or autologin) */
  owner_id: string;
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
  /** Owning app user id (OIDC sub or autologin) */
  owner_id: string;
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
  /** Schema marker for multi-user support */
  schema_version: number;
  users: AppUser[];
  /**
   * OIDC user id that received legacy no-auth (autologin) data.
   * null until the first SSO login claims it.
   */
  legacy_claimed_by: string | null;
  repos: Repo[];
  releases: Release[];
  release_assets: ReleaseAsset[];
  sync_logs: SyncLog[];
  /** Per-user settings (keyed by user id) */
  settings_by_user: Record<string, Settings>;
  lists: List[];
  repo_lists: RepoList[];
  /** Per-user linked GitHub accounts */
  github_accounts: Record<string, GithubAccount>;
  // Legacy single-tenant fields (migrated away on load)
  settings?: Settings;
  github_account?: GithubAccount | null;
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

const SCHEMA_VERSION = 2;

let data: Data | null = null;
let nextIds: Record<string, number> = {};

function isLegacyOwner(ownerId: string | undefined | null): boolean {
  return !ownerId || ownerId === AUTOLOGIN_USER_ID;
}

function migrate(raw: Record<string, unknown>): Data {
  const d = raw as unknown as Data;

  if (!Array.isArray(d.users)) d.users = [];
  if (d.legacy_claimed_by === undefined) d.legacy_claimed_by = null;

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

  // settings → settings_by_user
  if (!d.settings_by_user || typeof d.settings_by_user !== 'object') {
    d.settings_by_user = {};
  }
  if (d.settings && Object.keys(d.settings_by_user).length === 0) {
    d.settings_by_user[AUTOLOGIN_USER_ID] = {
      ...DEFAULT_SETTINGS,
      ...d.settings,
    };
  }
  delete d.settings;

  // github_account → github_accounts
  if (!d.github_accounts || typeof d.github_accounts !== 'object') {
    d.github_accounts = {};
  }
  if (d.github_account && Object.keys(d.github_accounts).length === 0) {
    d.github_accounts[AUTOLOGIN_USER_ID] = d.github_account;
  }
  delete d.github_account;

  // owner_id on repos / lists
  for (const r of d.repos) {
    if (!r.owner_id) r.owner_id = AUTOLOGIN_USER_ID;
  }
  for (const l of d.lists) {
    if (!l.owner_id) l.owner_id = AUTOLOGIN_USER_ID;
  }

  d.schema_version = SCHEMA_VERSION;
  return d;
}

function load(): Data {
  if (data) return data;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DB_PATH)) {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    data = migrate(raw);
  } else {
    data = emptyData();
  }
  const d = data!;

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
    schema_version: SCHEMA_VERSION,
    users: [],
    legacy_claimed_by: null,
    repos: [],
    releases: [],
    release_assets: [],
    sync_logs: [],
    settings_by_user: {},
    lists: [],
    repo_lists: [],
    github_accounts: {},
  };
}

function save() {
  if (data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }
}

function uid(): string {
  return getRequiredUserId();
}

function ownedRepos(userId: string): Repo[] {
  return load().repos.filter((r) => r.owner_id === userId);
}

function ownedLists(userId: string): List[] {
  return load().lists.filter((l) => l.owner_id === userId);
}

// ── Users / legacy claim ────────────────────────────────────────

/**
 * Upsert the SSO (or autologin) user. The first SSO login claims any data
 * created under the no-auth admin account.
 */
export function ensureAppUser(session: SessionUser): {
  user: AppUser;
  claimed_legacy: boolean;
} {
  load();
  const now = new Date().toISOString();
  let claimed_legacy = false;

  let user = data!.users.find((u) => u.id === session.id);
  if (!user) {
    user = {
      id: session.id,
      username: session.username,
      email: session.email,
      name: session.name,
      created_at: now,
      last_login_at: now,
    };
    data!.users.push(user);

    // First SSO user (not the synthetic autologin id) inherits legacy data
    if (
      session.id !== AUTOLOGIN_USER_ID &&
      data!.legacy_claimed_by == null
    ) {
      claimLegacyData(session.id);
      data!.legacy_claimed_by = session.id;
      claimed_legacy = true;
    }
  } else {
    user.username = session.username;
    user.email = session.email;
    user.name = session.name;
    user.last_login_at = now;
  }

  // Ensure settings bucket exists
  if (!data!.settings_by_user[session.id]) {
    data!.settings_by_user[session.id] = { ...DEFAULT_SETTINGS };
  }

  save();
  return { user: { ...user }, claimed_legacy };
}

/** Reassign autologin / unscoped data to `newOwnerId`. */
function claimLegacyData(newOwnerId: string) {
  const d = data!;
  for (const r of d.repos) {
    if (isLegacyOwner(r.owner_id)) r.owner_id = newOwnerId;
  }
  for (const l of d.lists) {
    if (isLegacyOwner(l.owner_id)) l.owner_id = newOwnerId;
  }

  if (d.settings_by_user[AUTOLOGIN_USER_ID] && !d.settings_by_user[newOwnerId]) {
    d.settings_by_user[newOwnerId] = {
      ...DEFAULT_SETTINGS,
      ...d.settings_by_user[AUTOLOGIN_USER_ID],
    };
  }
  delete d.settings_by_user[AUTOLOGIN_USER_ID];

  if (d.github_accounts[AUTOLOGIN_USER_ID] && !d.github_accounts[newOwnerId]) {
    d.github_accounts[newOwnerId] = d.github_accounts[AUTOLOGIN_USER_ID];
  }
  delete d.github_accounts[AUTOLOGIN_USER_ID];
}

export function getLegacyClaimStatus(): {
  claimed_by: string | null;
  unclaimed_repo_count: number;
} {
  const d = load();
  const unclaimed = d.repos.filter((r) => isLegacyOwner(r.owner_id)).length;
  return {
    claimed_by: d.legacy_claimed_by,
    unclaimed_repo_count: d.legacy_claimed_by ? 0 : unclaimed,
  };
}

/** All known user ids that own data or have logged in (for scheduler). */
export function listUserIds(): string[] {
  const d = load();
  const ids = new Set<string>();
  for (const u of d.users) ids.add(u.id);
  for (const r of d.repos) ids.add(r.owner_id);
  for (const l of d.lists) ids.add(l.owner_id);
  for (const k of Object.keys(d.settings_by_user)) ids.add(k);
  for (const k of Object.keys(d.github_accounts)) ids.add(k);
  // Always include autologin if any legacy remains
  if (d.repos.some((r) => isLegacyOwner(r.owner_id))) {
    ids.add(AUTOLOGIN_USER_ID);
  }
  if (ids.size === 0) ids.add(AUTOLOGIN_USER_ID);
  return [...ids];
}

// ── Scoped db view ──────────────────────────────────────────────

export function getDb() {
  const userId = uid();
  const d = load();
  const repos = ownedRepos(userId);
  const repoIds = new Set(repos.map((r) => r.id));
  return {
    repos,
    releases: d.releases.filter((r) => repoIds.has(r.repo_id)),
    releaseAssets: d.release_assets.filter((a) =>
      d.releases.some((r) => r.id === a.release_id && repoIds.has(r.repo_id))
    ),
    syncLogs: d.sync_logs.filter((l) => repoIds.has(l.repo_id)),
    settings: getSettings(),
    lists: ownedLists(userId),
    repoLists: d.repo_lists.filter((rl) => repoIds.has(rl.repo_id)),
    githubAccount: getGithubAccount(),
  };
}

export function getSettings(): Settings {
  const userId = tryGetUserId() ?? AUTOLOGIN_USER_ID;
  const stored = load().settings_by_user[userId];
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  load();
  const userId = uid();
  data!.settings_by_user[userId] = {
    ...DEFAULT_SETTINGS,
    ...data!.settings_by_user[userId],
    ...partial,
  };
  save();
  return getSettings();
}

// ── GitHub account ──────────────────────────────────────────────

export function getGithubAccount(): GithubAccount | null {
  const userId = tryGetUserId() ?? AUTOLOGIN_USER_ID;
  const acc = load().github_accounts[userId];
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
  const acc = getGithubAccount();
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
  const userId = uid();
  data!.github_accounts[userId] = {
    ...account,
    last_stars_scan_at: account.last_stars_scan_at ?? null,
    last_owned_scan_at: account.last_owned_scan_at ?? null,
    last_owned_import_at: account.last_owned_import_at ?? null,
    last_stars_import_at: account.last_stars_import_at ?? null,
  };
  save();
  return { ...data!.github_accounts[userId]! };
}

export function clearGithubAccount() {
  load();
  const userId = uid();
  delete data!.github_accounts[userId];
  save();
}

export function touchGithubImport() {
  load();
  const userId = uid();
  const acc = data!.github_accounts[userId];
  if (acc) {
    acc.last_stars_import_at = new Date().toISOString();
    save();
  }
}

export function touchGithubScan(
  kind: 'stars' | 'owned',
  opts: { imported?: boolean } = {}
) {
  load();
  const userId = uid();
  const acc = data!.github_accounts[userId];
  if (!acc) return;
  const now = new Date().toISOString();
  if (kind === 'stars') {
    acc.last_stars_scan_at = now;
    if (opts.imported) acc.last_stars_import_at = now;
  } else {
    acc.last_owned_scan_at = now;
    if (opts.imported) acc.last_owned_import_at = now;
  }
  save();
}

/** Prefer linked account token, then env GITHUB_TOKEN */
export function getGithubToken(): string | undefined {
  const acc = getGithubAccount();
  if (acc?.token) return acc.token;
  return process.env.GITHUB_TOKEN || undefined;
}

// ── Repos ───────────────────────────────────────────────────────

export function addRepo(
  repo: Omit<Repo, 'id' | 'created_at' | 'owner_id'> & {
    from_star?: boolean;
    owner_id?: string;
  }
): Repo {
  load();
  const now = new Date().toISOString();
  const newRepo: Repo = {
    ...repo,
    owner_id: repo.owner_id || uid(),
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
  const userId = uid();
  return load().repos.find(
    (r) =>
      r.owner_id === userId &&
      r.platform === platform &&
      r.owner === owner &&
      r.name === name
  );
}

export function getRepoById(id: number): Repo | undefined {
  const userId = uid();
  return load().repos.find((r) => r.id === id && r.owner_id === userId);
}

export function updateRepo(
  id: number,
  updates: Partial<Pick<Repo, 'last_synced_at' | 'from_star' | 'from_owned'>>
) {
  load();
  const userId = tryGetUserId();
  const idx = data!.repos.findIndex(
    (r) => r.id === id && (userId ? r.owner_id === userId : true)
  );
  if (idx >= 0) {
    Object.assign(data!.repos[idx], updates);
    save();
  }
}

export function deleteRepo(id: number) {
  load();
  const userId = uid();
  const repo = data!.repos.find((r) => r.id === id && r.owner_id === userId);
  if (!repo) return;

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
  return [...ownedLists(uid())].sort((a, b) => a.name.localeCompare(b.name));
}

export function getList(id: number): List | undefined {
  const userId = uid();
  return load().lists.find((l) => l.id === id && l.owner_id === userId);
}

export function getListByGithubId(githubListId: string): List | undefined {
  const userId = uid();
  return load().lists.find(
    (l) => l.owner_id === userId && l.github_list_id === githubListId
  );
}

export function getListByName(name: string): List | undefined {
  const userId = uid();
  const lower = name.toLowerCase();
  return load().lists.find(
    (l) => l.owner_id === userId && l.name.toLowerCase() === lower
  );
}

export function addList(
  input: Omit<List, 'id' | 'created_at' | 'updated_at' | 'owner_id'> & {
    owner_id?: string;
  }
): List {
  load();
  const now = new Date().toISOString();
  const list: List = {
    ...input,
    owner_id: input.owner_id || uid(),
    id: nextIds.lists++,
    created_at: now,
    updated_at: now,
  };
  data!.lists.push(list);
  save();
  return list;
}

/** Get or create a local system list by exact name (for current user). */
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
  const userId = uid();
  const idx = data!.lists.findIndex(
    (l) => l.id === id && l.owner_id === userId
  );
  if (idx < 0) return null;
  Object.assign(data!.lists[idx], updates, {
    updated_at: new Date().toISOString(),
  });
  save();
  return { ...data!.lists[idx] };
}

export function deleteList(id: number) {
  load();
  const userId = uid();
  const list = data!.lists.find((l) => l.id === id && l.owner_id === userId);
  if (!list) return;
  data!.lists = data!.lists.filter((l) => l.id !== id);
  data!.repo_lists = data!.repo_lists.filter((rl) => rl.list_id !== id);
  save();
}

export function getRepoListIds(repoId: number): number[] {
  // Ownership enforced via getRepoById at call sites; filter list links to owned lists
  const userId = uid();
  const ownedListIds = new Set(ownedLists(userId).map((l) => l.id));
  return load()
    .repo_lists.filter(
      (rl) => rl.repo_id === repoId && ownedListIds.has(rl.list_id)
    )
    .map((rl) => rl.list_id);
}

export function getRepoLists(repoId: number): List[] {
  const ids = new Set(getRepoListIds(repoId));
  return ownedLists(uid()).filter((l) => ids.has(l.id));
}

export function setRepoLists(repoId: number, listIds: number[]) {
  load();
  const userId = uid();
  const repo = data!.repos.find((r) => r.id === repoId && r.owner_id === userId);
  if (!repo) return;

  data!.repo_lists = data!.repo_lists.filter((rl) => rl.repo_id !== repoId);
  const unique = [...new Set(listIds)];
  for (const list_id of unique) {
    if (
      data!.lists.some((l) => l.id === list_id && l.owner_id === userId)
    ) {
      data!.repo_lists.push({ repo_id: repoId, list_id });
    }
  }
  save();
}

export function addRepoToList(repoId: number, listId: number) {
  load();
  const userId = uid();
  const repo = data!.repos.find((r) => r.id === repoId && r.owner_id === userId);
  const list = data!.lists.find((l) => l.id === listId && l.owner_id === userId);
  if (!repo || !list) return;

  const exists = data!.repo_lists.some(
    (rl) => rl.repo_id === repoId && rl.list_id === listId
  );
  if (!exists) {
    data!.repo_lists.push({ repo_id: repoId, list_id: listId });
    save();
  }
}

export function removeRepoFromList(repoId: number, listId: number) {
  load();
  const userId = uid();
  const repo = data!.repos.find((r) => r.id === repoId && r.owner_id === userId);
  if (!repo) return;
  data!.repo_lists = data!.repo_lists.filter(
    (rl) => !(rl.repo_id === repoId && rl.list_id === listId)
  );
  save();
}

export function getListRepoIds(listId: number): number[] {
  load();
  const userId = uid();
  const list = data!.lists.find((l) => l.id === listId && l.owner_id === userId);
  if (!list) return [];
  const ownedRepoIds = new Set(ownedRepos(userId).map((r) => r.id));
  return data!.repo_lists
    .filter((rl) => rl.list_id === listId && ownedRepoIds.has(rl.repo_id))
    .map((rl) => rl.repo_id);
}

export function getListCounts(): Record<number, number> {
  const userId = uid();
  const ownedRepoIds = new Set(ownedRepos(userId).map((r) => r.id));
  const ownedListIds = new Set(ownedLists(userId).map((l) => l.id));
  const counts: Record<number, number> = {};
  for (const rl of load().repo_lists) {
    if (!ownedRepoIds.has(rl.repo_id) || !ownedListIds.has(rl.list_id)) continue;
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
  const used = ownedLists(uid()).length;
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
