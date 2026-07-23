import path from 'path';
import fs from 'fs';
import {
  AUTOLOGIN_USER_ID,
  getRequiredUserId,
  tryGetUserId,
} from '@/lib/user-context';
import type { SessionUser } from '@/lib/session';
import { resolveUserDisplayName } from '@/lib/format';

function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getDbPath(): string {
  return path.join(getDataDir(), 'db.json');
}

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
  /**
   * When auto-importing stars, only import repos that belong to at least one
   * of these GitHub list IDs (GraphQL node IDs). Empty = import all new stars.
   */
  auto_import_stars_list_ids: string[];
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

  // ── Alerts (Apprise) ──────────────────────────────────────────
  /** Master switch for outbound alerts */
  alerts_enabled: boolean;
  /**
   * Apprise API base URL (e.g. http://apprise:8000).
   * Required to send notifications over HTTP.
   */
  apprise_api_url: string;
  /**
   * Optional custom endpoint URL. When set, overrides the default
   * {base}/notify or {base}/notify/{key} construction and POSTs directly
   * to this URL. Useful for custom webhooks or compatible proxies.
   * Admin-only (SSRF surface).
   */
  apprise_endpoint_url: string;
  /**
   * Optional stateful config key. When set, posts to /notify/{key}.
   * When empty, uses stateless /notify with apprise_urls.
   * Ignored when apprise_endpoint_url is set.
   */
  apprise_config_key: string;
  /**
   * Apprise notification URLs for stateless mode (or fallback when no key).
   * e.g. discord://id/token, tgram://bot/chat, mailto://...
   */
  apprise_urls: string[];
  /**
   * When true, send the alert category as an Apprise `tag` so URLs can be
   * routed by category in Apprise configuration.
   */
  apprise_use_tags: boolean;

  /** Alert when a new release tag is discovered */
  alert_new_release: boolean;
  /** Alert when remote releases disappear (were archived, now empty) */
  alert_releases_wiped: boolean;
  /** Alert when git history is force-rewritten or mass-deleted */
  alert_history_wiped: boolean;
  /** Alert when the remote repository is gone (404 / not found) */
  alert_repo_deleted: boolean;
  /** Alert when the remote repository is marked as archived */
  alert_repo_archived: boolean;
  /** Alert when a repo sync fails for other reasons */
  alert_sync_failed: boolean;
  /** Alert when DATA_DIR disk usage is high / free space is low */
  alert_storage_low: boolean;
  /** Alert when system/cgroup memory is critically low */
  alert_memory_low: boolean;

  /** Disk usage % above which storage_low fires (1–100) */
  storage_alert_threshold_percent: number;
  /** Free disk MB below which storage_low fires */
  storage_alert_min_free_mb: number;

  /** Admin-set global upper bound for max_asset_size_mb. 0 = no limit. */
  global_max_asset_size_mb: number;

  /**
   * Hostnames the user has approved for release-asset downloads
   * (Forgejo CDN / alternate download domains beyond the repo host).
   */
  approved_asset_hosts: string[];
  /** Hostnames the user has rejected — never download assets from these. */
  rejected_asset_hosts: string[];

  // ── Wayback Machine (README absolute URLs) ────────────────────
  /**
   * When enabled, absolute http(s) URLs found in each repo's README are
   * submitted to the Internet Archive Save Page Now (SPN2) API during sync.
   * Off by default. Requires archive.org S3 API keys below.
   */
  wayback_readme_urls_enabled: boolean;
  /**
   * Internet Archive S3 access key (from https://archive.org/account/s3.php).
   * Sent as `Authorization: LOW access:secret` to web.archive.org/save.
   */
  wayback_access_key: string;
  /** Internet Archive S3 secret key (paired with wayback_access_key). */
  wayback_secret_key: string;
}

export const DEFAULT_SETTINGS: Settings = {
  auto_sync_enabled: true,
  sync_interval_hours: 24,
  download_release_assets: true,
  max_asset_size_mb: 500,
  concurrent_syncs: 1,
  auto_scan_stars_enabled: false,
  auto_import_stars_enabled: false,
  auto_import_stars_list_ids: [],
  auto_scan_owned_enabled: false,
  auto_import_owned_enabled: false,
  github_scan_interval_hours: 24,
  auto_import_owned_include_forks: false,
  auto_import_owned_include_private: true,
  memory_aware_enabled: true,
  min_free_memory_mb: 256,
  max_memory_usage_ratio: 0.8,

  alerts_enabled: false,
  apprise_api_url: '',
  apprise_endpoint_url: '',
  apprise_config_key: '',
  apprise_urls: [],
  apprise_use_tags: false,

  alert_new_release: true,
  alert_releases_wiped: true,
  alert_history_wiped: true,
  alert_repo_deleted: true,
  alert_repo_archived: true,
  alert_sync_failed: false,
  alert_storage_low: true,
  alert_memory_low: true,

  storage_alert_threshold_percent: 90,
  storage_alert_min_free_mb: 1024,

  global_max_asset_size_mb: 0,

  approved_asset_hosts: [],
  rejected_asset_hosts: [],

  wayback_readme_urls_enabled: false,
  wayback_access_key: '',
  wayback_secret_key: '',
};

/** Pending user prompt for an untrusted release-asset download host. */
export interface PendingAssetHostApproval {
  hostname: string;
  sample_url: string;
  repo_label: string;
  first_seen_at: string;
}

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

/** Shared on-disk content for a (platform, owner, name) identity. */
export interface Archive {
  id: number;
  /** Platform id: github | gitlab | codeberg | or hostname for arbitrary hosts */
  platform: string;
  owner: string;
  name: string;
  clone_url: string;
  mirror_path: string;
  last_synced_at: string | null;
  /**
   * Private archives are never shared across users. Public ones may have
   * multiple memberships pointing at the same archive.
   */
  is_private?: boolean;

  // ── Cached remote metadata (refreshed on sync) ────────────────
  remote_description?: string | null;
  topics?: string[];
  language?: string | null;
  homepage?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  license?: string | null;
  is_archived?: boolean;
  is_fork?: boolean;
  /** Set when the remote API or git fetch confirms the repo is gone. */
  remote_deleted_at?: string | null;
  remote_updated_at?: string | null;
  remote_meta_synced_at?: string | null;
}

/**
 * User membership row (persisted). Hydrated with archive fields for the
 * public `Repo` view returned by getDb / getRepoById.
 */
interface RepoMembership {
  id: number;
  owner_id: string;
  archive_id: number;
  created_at: string;
  from_star?: boolean;
  from_owned?: boolean;
  local_description?: string | null;
}

/**
 * Hydrated user-facing repository: membership + shared archive fields.
 * API routes and UI continue to use this shape; `id` is the membership id.
 */
export interface Repo {
  id: number;
  owner_id: string;
  archive_id: number;
  /** Platform id: github | gitlab | codeberg | or hostname for arbitrary hosts */
  platform: string;
  owner: string;
  name: string;
  clone_url: string;
  mirror_path: string;
  last_synced_at: string | null;
  created_at: string;
  from_star?: boolean;
  from_owned?: boolean;
  local_description?: string | null;
  remote_description?: string | null;
  topics?: string[];
  language?: string | null;
  homepage?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  license?: string | null;
  is_private?: boolean;
  is_archived?: boolean;
  is_fork?: boolean;
  remote_deleted_at?: string | null;
  remote_updated_at?: string | null;
  remote_meta_synced_at?: string | null;
}

interface Release {
  id: number;
  /** Shared archive this release belongs to */
  archive_id: number;
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
  /** Membership (user-facing repo) id */
  repo_id: number;
  status: 'success' | 'failed';
  message: string | null;
  created_at: string;
}

interface Data {
  /** Schema marker for multi-user + archive dedup */
  schema_version: number;
  users: AppUser[];
  /**
   * OIDC user id that received legacy no-auth (autologin) data.
   * null until the first SSO login claims it.
   */
  legacy_claimed_by: string | null;
  archives: Archive[];
  /** User memberships (persisted as RepoMembership; hydrated on read) */
  repos: RepoMembership[];
  releases: Release[];
  release_assets: ReleaseAsset[];
  sync_logs: SyncLog[];
  /** Per-user settings (keyed by user id) */
  settings_by_user: Record<string, Settings>;
  lists: List[];
  repo_lists: RepoList[];
  /** Per-user linked GitHub accounts */
  github_accounts: Record<string, GithubAccount>;
  /**
   * Per-user queue of release-asset hosts awaiting approve/reject.
   * Populated during sync when a Forgejo (or other) host serves assets
   * from a domain outside the built-in + repo-host allowlist.
   */
  pending_asset_host_approvals_by_user: Record<
    string,
    PendingAssetHostApproval[]
  >;
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

const SCHEMA_VERSION = 4;

let data: Data | null = null;
let nextIds: Record<string, number> = {};

function isLegacyOwner(ownerId: string | undefined | null): boolean {
  return !ownerId || ownerId === AUTOLOGIN_USER_ID;
}

export function identityKey(
  platform: string,
  owner: string,
  name: string
): string {
  return `${platform}\0${owner.toLowerCase()}\0${name.toLowerCase()}`;
}

function hydrateRepo(m: RepoMembership, archive: Archive | undefined): Repo {
  if (!archive) {
    // Orphan membership — surface minimal row so callers can still detect it
    return {
      id: m.id,
      owner_id: m.owner_id,
      archive_id: m.archive_id,
      platform: 'github',
      owner: '?',
      name: '?',
      clone_url: '',
      mirror_path: '',
      last_synced_at: null,
      created_at: m.created_at,
      from_star: m.from_star,
      from_owned: m.from_owned,
      local_description: m.local_description ?? null,
    };
  }
  return {
    id: m.id,
    owner_id: m.owner_id,
    archive_id: m.archive_id,
    platform: archive.platform,
    owner: archive.owner,
    name: archive.name,
    clone_url: archive.clone_url,
    mirror_path: archive.mirror_path,
    last_synced_at: archive.last_synced_at,
    created_at: m.created_at,
    from_star: m.from_star,
    from_owned: m.from_owned,
    local_description: m.local_description ?? null,
    remote_description: archive.remote_description ?? null,
    topics: archive.topics ?? [],
    language: archive.language ?? null,
    homepage: archive.homepage ?? null,
    stargazers_count: archive.stargazers_count ?? null,
    forks_count: archive.forks_count ?? null,
    license: archive.license ?? null,
    is_private: Boolean(archive.is_private),
    is_archived: Boolean(archive.is_archived),
    is_fork: Boolean(archive.is_fork),
    remote_deleted_at: archive.remote_deleted_at ?? null,
    remote_updated_at: archive.remote_updated_at ?? null,
    remote_meta_synced_at: archive.remote_meta_synced_at ?? null,
  };
}

function archiveById(d: Data, id: number): Archive | undefined {
  return d.archives.find((a) => a.id === id);
}

/** Best-effort recursive directory size for migration ranking. */
function dirSizeSafe(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += dirSizeSafe(full);
      else total += fs.statSync(full).size;
    }
    return total;
  } catch {
    return 0;
  }
}

function parseTimeMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Migrate schema v1/v2 flat repos into archives + memberships.
 * - Public identity groups with multiple users → one shared archive.
 * - Private (or mixed) groups → one archive per former row (no share).
 */
function migrateToArchives(d: Data): void {
  if (Array.isArray(d.archives) && d.archives.length > 0) {
    // Already migrated or partially present
    return;
  }
  if (!Array.isArray(d.archives)) d.archives = [];

  // Legacy shape: repos held full fields + optional missing archive_id
  type LegacyRepo = RepoMembership &
    Partial<Archive> & {
      platform?: string;
      owner?: string;
      name?: string;
      clone_url?: string;
      mirror_path?: string;
      last_synced_at?: string | null;
      is_private?: boolean;
    };

  const legacyRepos = d.repos as unknown as LegacyRepo[];
  if (legacyRepos.length === 0) return;

  // Already membership-only rows with archive_id and empty archives is corrupt;
  // only run when rows still look like full repos.
  const looksLegacy = legacyRepos.some(
    (r) => r.platform && r.owner && r.name && r.mirror_path && !r.archive_id
  );
  if (!looksLegacy && legacyRepos.every((r) => r.archive_id)) {
    return;
  }

  // Group by identity
  const groups = new Map<string, LegacyRepo[]>();
  for (const r of legacyRepos) {
    if (!r.platform || !r.owner || !r.name) continue;
    const key = identityKey(r.platform, r.owner, r.name);
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }

  const newArchives: Archive[] = [];
  const newMemberships: RepoMembership[] = [];
  let nextArchiveId =
    d.archives.reduce((max, a) => Math.max(max, a.id), 0) + 1;

  // Map old repo id → archive id for release rekey
  const oldRepoToArchive = new Map<number, number>();

  for (const [, group] of groups) {
    const anyPrivate = group.some((r) => Boolean(r.is_private));
    // Safer: if any is private, do not merge across users
    const canShare = !anyPrivate && group.length >= 1;

    if (canShare && group.every((r) => !r.is_private)) {
      // Prefer largest existing mirror / most recently synced as canonical
      const ranked = [...group].sort((a, b) => {
        const sizeDiff =
          dirSizeSafe(b.mirror_path || '') - dirSizeSafe(a.mirror_path || '');
        if (sizeDiff !== 0) return sizeDiff;
        return (
          parseTimeMs(b.last_synced_at) - parseTimeMs(a.last_synced_at)
        );
      });
      const primary = ranked[0];
      const archiveId = nextArchiveId++;
      const archive: Archive = {
        id: archiveId,
        platform: primary.platform!,
        owner: primary.owner!,
        name: primary.name!,
        clone_url: primary.clone_url || '',
        mirror_path: primary.mirror_path || '',
        last_synced_at: primary.last_synced_at ?? null,
        is_private: false,
        remote_description: primary.remote_description ?? null,
        topics: primary.topics ?? [],
        language: primary.language ?? null,
        homepage: primary.homepage ?? null,
        stargazers_count: primary.stargazers_count ?? null,
        forks_count: primary.forks_count ?? null,
        license: primary.license ?? null,
        is_archived: primary.is_archived,
        is_fork: primary.is_fork,
        remote_updated_at: primary.remote_updated_at ?? null,
        remote_meta_synced_at: primary.remote_meta_synced_at ?? null,
      };
      // Prefer richest remote meta across group
      for (const r of ranked.slice(1)) {
        if (!archive.remote_description && r.remote_description) {
          archive.remote_description = r.remote_description;
        }
        if (
          (!archive.topics || archive.topics.length === 0) &&
          r.topics?.length
        ) {
          archive.topics = r.topics;
        }
        if (
          parseTimeMs(r.last_synced_at) > parseTimeMs(archive.last_synced_at)
        ) {
          archive.last_synced_at = r.last_synced_at ?? null;
        }
        if (
          parseTimeMs(r.remote_meta_synced_at) >
          parseTimeMs(archive.remote_meta_synced_at)
        ) {
          archive.remote_meta_synced_at = r.remote_meta_synced_at ?? null;
          archive.remote_description =
            r.remote_description ?? archive.remote_description;
          archive.topics = r.topics ?? archive.topics;
          archive.language = r.language ?? archive.language;
          archive.homepage = r.homepage ?? archive.homepage;
          archive.stargazers_count =
            r.stargazers_count ?? archive.stargazers_count;
          archive.forks_count = r.forks_count ?? archive.forks_count;
          archive.license = r.license ?? archive.license;
          archive.is_archived = r.is_archived ?? archive.is_archived;
          archive.is_fork = r.is_fork ?? archive.is_fork;
          archive.remote_updated_at =
            r.remote_updated_at ?? archive.remote_updated_at;
        }
      }
      // Prefer canonical shared path layout when possible
      const sharedPath = path.join(
        getDataDir(),
        'mirrors',
        primary.platform!,
        primary.owner!,
        primary.name! + '.git'
      );
      if (
        archive.mirror_path &&
        path.resolve(archive.mirror_path) !== path.resolve(sharedPath)
      ) {
        try {
          if (
            fs.existsSync(archive.mirror_path) &&
            !fs.existsSync(sharedPath)
          ) {
            fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
            fs.renameSync(archive.mirror_path, sharedPath);
            archive.mirror_path = sharedPath;
          } else if (fs.existsSync(sharedPath)) {
            // Shared path already has content — drop the user-scoped extra
            if (fs.existsSync(archive.mirror_path)) {
              fs.rmSync(archive.mirror_path, { recursive: true, force: true });
            }
            archive.mirror_path = sharedPath;
          }
        } catch {
          // keep primary path if move fails
        }
      }

      newArchives.push(archive);

      // Drop duplicate on-disk mirrors for non-primary members
      for (const r of ranked.slice(1)) {
        if (
          r.mirror_path &&
          path.resolve(r.mirror_path) !== path.resolve(archive.mirror_path) &&
          fs.existsSync(r.mirror_path)
        ) {
          try {
            fs.rmSync(r.mirror_path, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      }

      for (const r of group) {
        oldRepoToArchive.set(r.id, archiveId);
        newMemberships.push({
          id: r.id,
          owner_id: r.owner_id || AUTOLOGIN_USER_ID,
          archive_id: archiveId,
          created_at: r.created_at || new Date().toISOString(),
          from_star: r.from_star,
          from_owned: r.from_owned,
          local_description: r.local_description ?? null,
        });
      }
    } else {
      // One archive per membership (private isolation)
      for (const r of group) {
        const archiveId = nextArchiveId++;
        newArchives.push({
          id: archiveId,
          platform: r.platform!,
          owner: r.owner!,
          name: r.name!,
          clone_url: r.clone_url || '',
          mirror_path: r.mirror_path || '',
          last_synced_at: r.last_synced_at ?? null,
          is_private: Boolean(r.is_private),
          remote_description: r.remote_description ?? null,
          topics: r.topics ?? [],
          language: r.language ?? null,
          homepage: r.homepage ?? null,
          stargazers_count: r.stargazers_count ?? null,
          forks_count: r.forks_count ?? null,
          license: r.license ?? null,
          is_archived: r.is_archived,
          is_fork: r.is_fork,
          remote_updated_at: r.remote_updated_at ?? null,
          remote_meta_synced_at: r.remote_meta_synced_at ?? null,
        });
        oldRepoToArchive.set(r.id, archiveId);
        newMemberships.push({
          id: r.id,
          owner_id: r.owner_id || AUTOLOGIN_USER_ID,
          archive_id: archiveId,
          created_at: r.created_at || new Date().toISOString(),
          from_star: r.from_star,
          from_owned: r.from_owned,
          local_description: r.local_description ?? null,
        });
      }
    }
  }

  d.archives = newArchives;
  d.repos = newMemberships;

  // Rekey releases: repo_id → archive_id; merge duplicates when sharing
  type LegacyRelease = Release & { repo_id?: number; archive_id?: number };
  const legacyReleases = (d.releases || []) as LegacyRelease[];
  const assetsByRelease = new Map<number, ReleaseAsset[]>();
  for (const a of d.release_assets || []) {
    const list = assetsByRelease.get(a.release_id) || [];
    list.push(a);
    assetsByRelease.set(a.release_id, list);
  }

  // Group releases by (archive_id, tag_name); keep richest
  const releaseKey = (archiveId: number, tag: string) =>
    `${archiveId}\0${tag}`;
  const bestRelease = new Map<
    string,
    { release: Release; oldId: number; assetScore: number }
  >();

  for (const rel of legacyReleases) {
    const oldRepoId = rel.repo_id ?? rel.archive_id;
    if (oldRepoId == null) continue;
    const archiveId = oldRepoToArchive.get(oldRepoId) ?? rel.archive_id;
    if (archiveId == null) continue;
    const assets = assetsByRelease.get(rel.id) || [];
    const score =
      assets.length + assets.filter((a) => a.file_path).length * 10;
    const key = releaseKey(archiveId, rel.tag_name);
    const prev = bestRelease.get(key);
    if (!prev || score > prev.assetScore) {
      bestRelease.set(key, {
        release: {
          id: rel.id,
          archive_id: archiveId,
          tag_name: rel.tag_name,
          name: rel.name,
          body: rel.body,
          published_at: rel.published_at,
          created_at: rel.created_at,
        },
        oldId: rel.id,
        assetScore: score,
      });
    }
  }

  const keptOldReleaseIds = new Set(
    [...bestRelease.values()].map((v) => v.oldId)
  );
  d.releases = [...bestRelease.values()].map((v) => v.release);
  d.release_assets = (d.release_assets || []).filter((a) =>
    keptOldReleaseIds.has(a.release_id)
  );
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
    'archives',
  ] as const) {
    if (!Array.isArray((d as any)[key])) (d as any)[key] = [];
  }

  // settings → settings_by_user
  if (!d.settings_by_user || typeof d.settings_by_user !== 'object') {
    d.settings_by_user = {};
  }
  if (
    !d.pending_asset_host_approvals_by_user ||
    typeof d.pending_asset_host_approvals_by_user !== 'object'
  ) {
    d.pending_asset_host_approvals_by_user = {};
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
  for (const r of d.repos as RepoMembership[]) {
    if (!r.owner_id) r.owner_id = AUTOLOGIN_USER_ID;
  }
  for (const l of d.lists) {
    if (!l.owner_id) l.owner_id = AUTOLOGIN_USER_ID;
  }

  // v2 → v3: split archives / memberships; rekey releases
  if ((d.schema_version || 0) < 3 || !d.archives?.length) {
    // Only migrate when repos still look legacy OR archives empty with legacy fields
    migrateToArchives(d);
  }

  // Normalize release rows that still use repo_id
  for (const rel of d.releases as (Release & { repo_id?: number })[]) {
    if (rel.archive_id == null && (rel as any).repo_id != null) {
      // Try membership id → archive_id
      const m = d.repos.find((r) => r.id === (rel as any).repo_id);
      if (m) rel.archive_id = m.archive_id;
      else rel.archive_id = (rel as any).repo_id;
    }
    delete (rel as any).repo_id;
  }

  // v3 → v4: fix archives whose platform was hardcoded to github on import
  // even though clone_url points at gitlab.com (and vice versa).
  if ((d.schema_version || 0) < 4) {
    repairArchivePlatformFromCloneUrl(d);
  }

  d.schema_version = SCHEMA_VERSION;
  return d;
}

/**
 * Infer platform id from a clone URL host. Returns null if unknown.
 * Kept local to avoid circular imports with releases.ts / platform.ts.
 */
function inferPlatformFromCloneUrl(
  cloneUrl: string | null | undefined
): string | null {
  if (!cloneUrl || typeof cloneUrl !== 'string') return null;
  const s = cloneUrl.trim().toLowerCase();
  // git@gitlab.com:group/project.git  or  https://gitlab.com/...
  if (
    /(^|[@/.])gitlab\.com([/:]|$)/.test(s) ||
    s.includes('://gitlab.com/') ||
    s.startsWith('git@gitlab.com:')
  ) {
    return 'gitlab';
  }
  if (
    /(^|[@/.])github\.com([/:]|$)/.test(s) ||
    s.includes('://github.com/') ||
    s.startsWith('git@github.com:')
  ) {
    return 'github';
  }
  if (
    /(^|[@/.])codeberg\.org([/:]|$)/.test(s) ||
    s.includes('://codeberg.org/') ||
    s.startsWith('git@codeberg.org:')
  ) {
    return 'codeberg';
  }
  return null;
}

/**
 * Repair archives that store platform "github" with a gitlab.com clone_url
 * (bug from importOne hardcoding platform). Relocates the bare mirror when
 * the on-disk path embeds the wrong platform segment.
 */
function repairArchivePlatformFromCloneUrl(d: Data): void {
  for (const a of d.archives) {
    const inferred = inferPlatformFromCloneUrl(a.clone_url);
    if (!inferred || inferred === a.platform) continue;

    const oldPlatform = a.platform;
    console.warn(
      `[db] repair archive #${a.id} ${a.owner}/${a.name}: platform ${oldPlatform} → ${inferred} (from clone_url)`
    );
    a.platform = inferred;

    if (!a.mirror_path) continue;

    // Replace /{oldPlatform}/ path segment with /{inferred}/
    const re = new RegExp(
      `(^|[/\\\\])${oldPlatform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([/\\\\])`
    );
    if (!re.test(a.mirror_path)) continue;

    const newPath = a.mirror_path.replace(re, `$1${inferred}$2`);
    if (newPath === a.mirror_path) continue;

    try {
      if (fs.existsSync(a.mirror_path) && !fs.existsSync(newPath)) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(a.mirror_path, newPath);
        a.mirror_path = newPath;
      } else if (fs.existsSync(newPath)) {
        // Target already present — drop the mis-tagged copy
        if (fs.existsSync(a.mirror_path)) {
          fs.rmSync(a.mirror_path, { recursive: true, force: true });
        }
        a.mirror_path = newPath;
      } else {
        // Neither exists (mirror missing) — still rewrite the recorded path
        a.mirror_path = newPath;
      }
    } catch (err) {
      console.error(
        `[db] failed to relocate mirror for archive #${a.id}:`,
        err instanceof Error ? err.message : err
      );
      // Keep platform fix even if move failed; path may be updated on next sync
      a.mirror_path = newPath;
    }
  }
}

function getDbBakPath(): string {
  return getDbPath() + '.bak';
}

function getDbTmpPath(): string {
  return getDbPath() + '.tmp';
}

/**
 * Parse + migrate a db file. Returns null on missing file or JSON/schema errors.
 */
function readDbFile(filePath: string): { data: Data; prevVersion: number } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) {
      console.error(`[db] empty file: ${filePath}`);
      return null;
    }
    const raw = JSON.parse(text);
    const prevVersion = Number(raw.schema_version) || 0;
    return { data: migrate(raw), prevVersion };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db] failed to parse ${filePath}: ${msg}`);
    return null;
  }
}

/**
 * Move a corrupt primary db out of the way so a fresh file can be written.
 * Keeps the bytes for manual recovery.
 */
function quarantineCorruptDb(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const dest = `${dbPath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(dbPath, dest);
    console.error(
      `[db] quarantined corrupt database to ${dest}. ` +
        `Restore a known-good backup or re-import; a new empty db will be created.`
    );
    return dest;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db] could not quarantine ${dbPath}: ${msg}`);
    return null;
  }
}

function recomputeNextIds(d: Data): void {
  nextIds.repos = d.repos.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.archives =
    d.archives.reduce((max, a) => Math.max(max, a.id), 0) + 1;
  nextIds.releases = d.releases.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.release_assets =
    d.release_assets.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.sync_logs = d.sync_logs.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  nextIds.lists = d.lists.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

function load(): Data {
  if (data) return data;
  const dataDir = getDataDir();
  const dbPath = getDbPath();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Drop leftover partial write from a crash mid-save
  const tmpPath = getDbTmpPath();
  if (fs.existsSync(tmpPath)) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }

  let prevVersion = 0;
  const primary = readDbFile(dbPath);
  if (primary) {
    data = primary.data;
    prevVersion = primary.prevVersion;
  } else {
    // Primary missing or corrupt — try last successful backup
    const backup = readDbFile(getDbBakPath());
    if (backup) {
      console.warn(`[db] restored from ${getDbBakPath()}`);
      data = backup.data;
      prevVersion = backup.prevVersion;
      // Rewrite primary immediately so the next boot uses it
      save();
    } else {
      if (fs.existsSync(dbPath)) {
        quarantineCorruptDb(dbPath);
      }
      data = emptyData();
      prevVersion = SCHEMA_VERSION;
      save();
    }
  }

  // Persist when schema advanced
  if (prevVersion < SCHEMA_VERSION) {
    save();
  }

  recomputeNextIds(data!);
  return data!;
}

/**
 * Preload db.json into the in-memory cache (process start / instrumentation).
 * Avoids paying parse cost on the first HTTP request.
 */
export function warmDb(): void {
  load();
}

/**
 * Clear in-memory cache so the next load() re-reads DATA_DIR/db.json.
 * Intended for unit tests only.
 */
export function resetDbForTests(): void {
  data = null;
  nextIds = {};
}

function emptyData(): Data {
  return {
    schema_version: SCHEMA_VERSION,
    users: [],
    legacy_claimed_by: null,
    archives: [],
    repos: [],
    releases: [],
    release_assets: [],
    sync_logs: [],
    settings_by_user: {},
    lists: [],
    repo_lists: [],
    github_accounts: {},
    pending_asset_host_approvals_by_user: {},
  };
}

/**
 * Atomic save: write to db.json.tmp, fsync, rename over db.json.
 * After a successful replace, copies the new primary to db.json.bak.
 *
 * Direct writeFileSync(db.json) is unsafe — a kill/OOM mid-write leaves
 * truncated JSON ("Unterminated string") and takes the app down.
 *
 * Order matters: never copy primary → bak *before* the rename, or a corrupt
 * primary would clobber a good backup during recovery.
 */
function save() {
  if (!data) return;

  const dbPath = getDbPath();
  const tmpPath = getDbTmpPath();
  const bakPath = getDbBakPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify(data, null, 2);

  // 1. Write temp file fully, then fsync so the bytes hit disk
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // 2. Atomic replace on the same filesystem (POSIX rename is atomic)
  fs.renameSync(tmpPath, dbPath);

  // 3. Fsync the directory so the rename is durable (otherwise a crash can
  //    lose the directory entry, leaving only the .tmp)
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }

  // 4. Snapshot the new good primary as .bak (best-effort)
  try {
    fs.copyFileSync(dbPath, bakPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[db] could not update ${bakPath}: ${msg}`);
  }
}

export function uid(): string {
  return getRequiredUserId();
}

function ownedMemberships(userId: string): RepoMembership[] {
  return load().repos.filter((r) => r.owner_id === userId);
}

function ownedLists(userId: string): List[] {
  return load().lists.filter((l) => l.owner_id === userId);
}

function hydrateOwned(userId: string): Repo[] {
  const d = load();
  return ownedMemberships(userId).map((m) =>
    hydrateRepo(m, archiveById(d, m.archive_id))
  );
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
  if (d.repos.some((r) => isLegacyOwner(r.owner_id))) {
    ids.add(AUTOLOGIN_USER_ID);
  }
  if (ids.size === 0) ids.add(AUTOLOGIN_USER_ID);
  return [...ids];
}

/** Admin overview: registered users + storage attributed to their memberships. */
export interface UserUsageSummary {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  created_at: string | null;
  last_login_at: string | null;
  /** True when the user has an AppUser row (SSO login), not just orphaned data. */
  registered: boolean;
  repo_count: number;
  private_repo_count: number;
  /**
   * Bytes attributed to this user: exclusive private archives fully,
   * shared public archives split evenly among members.
   */
  storage_bytes: number;
}

/** One membership's storage contribution for the current (or given) user. */
export interface RepoStorageEntry {
  /** User-facing membership id (for /repos/[id] links) */
  repo_id: number;
  archive_id: number;
  platform: string;
  owner: string;
  name: string;
  is_private: boolean;
  /** Full on-disk size of this archive (mirror + assets) */
  total_bytes: number;
  /** Mirror tree size on disk */
  mirror_bytes: number;
  /** Downloaded release assets on disk */
  asset_bytes: number;
  /** Bytes attributed to this user (full if private/sole, else split) */
  attributed_bytes: number;
  /** How many users share this archive */
  member_count: number;
}

/** Per-user storage view with largest-repo breakdown. */
export interface UserStorageDetail {
  total_bytes: number;
  repo_count: number;
  private_repo_count: number;
  /** Top N repos by attributed size (default 5) */
  largest_repos: RepoStorageEntry[];
  /** Attributed bytes for repos outside largest_repos */
  other_bytes: number;
  /** Number of repos not listed in largest_repos */
  other_repo_count: number;
}

/** Release asset bytes keyed by archive_id (prefer on-disk size when path exists). */
function assetBytesByArchiveMap(d: Data): Map<number, number> {
  const assetBytesByArchive = new Map<number, number>();
  const releaseToArchive = new Map<number, number>();
  for (const rel of d.releases) {
    releaseToArchive.set(rel.id, rel.archive_id);
  }
  for (const asset of d.release_assets) {
    const archiveId = releaseToArchive.get(asset.release_id);
    if (archiveId == null) continue;
    let bytes = 0;
    if (asset.file_path) {
      try {
        if (fs.existsSync(asset.file_path)) {
          bytes = fs.statSync(asset.file_path).size;
        } else if (typeof asset.size === 'number' && asset.size > 0) {
          bytes = asset.size;
        }
      } catch {
        if (typeof asset.size === 'number' && asset.size > 0) bytes = asset.size;
      }
    }
    assetBytesByArchive.set(
      archiveId,
      (assetBytesByArchive.get(archiveId) || 0) + bytes
    );
  }
  return assetBytesByArchive;
}

function membersByArchiveMap(d: Data): Map<number, Set<string>> {
  const membersByArchive = new Map<number, Set<string>>();
  for (const m of d.repos) {
    let set = membersByArchive.get(m.archive_id);
    if (!set) {
      set = new Set();
      membersByArchive.set(m.archive_id, set);
    }
    set.add(m.owner_id);
  }
  return membersByArchive;
}

/**
 * List every known user with membership counts and attributed on-disk storage.
 * Shared public archives count `size / memberCount` toward each member.
 * Does not require a user context (admin-only callers).
 */
export function listUsersWithUsage(): UserUsageSummary[] {
  const d = load();
  const appUsers = new Map(d.users.map((u) => [u.id, u]));
  const ids = new Set(listUserIds());

  const membersByArchive = membersByArchiveMap(d);
  const assetBytesByArchive = assetBytesByArchiveMap(d);
  const repoCountByUser = new Map<string, number>();
  const privateCountByUser = new Map<string, number>();

  for (const m of d.repos) {
    ids.add(m.owner_id);
    repoCountByUser.set(m.owner_id, (repoCountByUser.get(m.owner_id) || 0) + 1);
  }

  const storageByUser = new Map<string, number>();
  for (const archive of d.archives) {
    const members = membersByArchive.get(archive.id);
    if (!members || members.size === 0) continue;

    if (archive.is_private) {
      for (const memberId of members) {
        privateCountByUser.set(
          memberId,
          (privateCountByUser.get(memberId) || 0) + 1
        );
      }
    }

    const mirrorBytes = dirSizeSafe(archive.mirror_path || '');
    const assetBytes = assetBytesByArchive.get(archive.id) || 0;
    const total = mirrorBytes + assetBytes;
    if (total <= 0) continue;
    const share = total / members.size;
    for (const memberId of members) {
      storageByUser.set(memberId, (storageByUser.get(memberId) || 0) + share);
    }
  }

  const summaries: UserUsageSummary[] = [];
  for (const id of ids) {
    const app = appUsers.get(id);
    summaries.push({
      id,
      username: app
        ? resolveUserDisplayName(app)
        : id,
      email: app?.email ?? null,
      name: app?.name ?? null,
      created_at: app?.created_at ?? null,
      last_login_at: app?.last_login_at ?? null,
      registered: Boolean(app),
      repo_count: repoCountByUser.get(id) || 0,
      private_repo_count: privateCountByUser.get(id) || 0,
      storage_bytes: Math.round(storageByUser.get(id) || 0),
    });
  }

  summaries.sort((a, b) => {
    // Registered users first, then by storage desc, then username
    if (a.registered !== b.registered) return a.registered ? -1 : 1;
    if (b.storage_bytes !== a.storage_bytes) {
      return b.storage_bytes - a.storage_bytes;
    }
    return a.username.localeCompare(b.username);
  });

  return summaries;
}

/**
 * Storage usage for one user, with the largest repos by attributed size.
 * Defaults to the current user context when `userId` is omitted.
 */
export function getUserStorageDetail(
  userId?: string,
  topN = 5
): UserStorageDetail {
  const d = load();
  const uid = userId ?? getRequiredUserId();
  const membersByArchive = membersByArchiveMap(d);
  const assetBytesByArchive = assetBytesByArchiveMap(d);
  const memberships = d.repos.filter((m) => m.owner_id === uid);

  const entries: RepoStorageEntry[] = [];
  let privateRepoCount = 0;

  for (const m of memberships) {
    const archive = archiveById(d, m.archive_id);
    if (!archive) continue;
    const members = membersByArchive.get(archive.id);
    const memberCount = members?.size || 1;
    const mirrorBytes = dirSizeSafe(archive.mirror_path || '');
    const assetBytes = assetBytesByArchive.get(archive.id) || 0;
    const totalBytes = mirrorBytes + assetBytes;
    const attributedBytes = totalBytes / memberCount;
    const isPrivate = Boolean(archive.is_private);
    if (isPrivate) privateRepoCount++;

    entries.push({
      repo_id: m.id,
      archive_id: archive.id,
      platform: archive.platform,
      owner: archive.owner,
      name: archive.name,
      is_private: isPrivate,
      total_bytes: Math.round(totalBytes),
      mirror_bytes: Math.round(mirrorBytes),
      asset_bytes: Math.round(assetBytes),
      attributed_bytes: Math.round(attributedBytes),
      member_count: memberCount,
    });
  }

  entries.sort((a, b) => {
    if (b.attributed_bytes !== a.attributed_bytes) {
      return b.attributed_bytes - a.attributed_bytes;
    }
    return `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
  });

  const limit = Math.max(0, Math.min(50, Math.round(topN)));
  const largest = entries.slice(0, limit);
  const rest = entries.slice(limit);
  const otherBytes = rest.reduce((sum, e) => sum + e.attributed_bytes, 0);
  const totalBytes = entries.reduce((sum, e) => sum + e.attributed_bytes, 0);

  return {
    total_bytes: totalBytes,
    repo_count: entries.length,
    private_repo_count: privateRepoCount,
    largest_repos: largest,
    other_bytes: otherBytes,
    other_repo_count: rest.length,
  };
}

// ── Scoped db view ──────────────────────────────────────────────

export function getDb() {
  const userId = uid();
  const d = load();
  const repos = hydrateOwned(userId);
  const archiveIds = new Set(repos.map((r) => r.archive_id));
  const repoIds = new Set(repos.map((r) => r.id));
  return {
    repos,
    releases: d.releases.filter((r) => archiveIds.has(r.archive_id)),
    releaseAssets: d.release_assets.filter((a) =>
      d.releases.some(
        (r) => r.id === a.release_id && archiveIds.has(r.archive_id)
      )
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
  const settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!settings.apprise_api_url && process.env.APPRISE_API_URL) {
    settings.apprise_api_url = process.env.APPRISE_API_URL;
  }
  return settings;
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

// ── Archives ────────────────────────────────────────────────────

export function getArchiveById(id: number): Archive | undefined {
  return load().archives.find((a) => a.id === id);
}

/** Global public archive lookup (never returns private archives). */
export function findPublicArchive(
  platform: string,
  owner: string,
  name: string
): Archive | undefined {
  const key = identityKey(platform, owner, name);
  return load().archives.find(
    (a) =>
      !a.is_private &&
      identityKey(a.platform, a.owner, a.name) === key
  );
}

export function countArchiveMembers(archiveId: number): number {
  return load().repos.filter((r) => r.archive_id === archiveId).length;
}

export function getArchiveMembers(archiveId: number): RepoMembership[] {
  return load().repos.filter((r) => r.archive_id === archiveId);
}

/** All archives (for scheduler global due set). */
export function listArchives(): Archive[] {
  return [...load().archives];
}

export type ArchiveUpdatableFields = Partial<
  Pick<
    Archive,
    | 'last_synced_at'
    | 'clone_url'
    | 'mirror_path'
    | 'remote_description'
    | 'topics'
    | 'language'
    | 'homepage'
    | 'stargazers_count'
    | 'forks_count'
    | 'license'
    | 'is_private'
    | 'is_archived'
    | 'is_fork'
    | 'remote_deleted_at'
    | 'remote_updated_at'
    | 'remote_meta_synced_at'
  >
>;

export function updateArchive(
  id: number,
  updates: ArchiveUpdatableFields
): void {
  load();
  const idx = data!.archives.findIndex((a) => a.id === id);
  if (idx >= 0) {
    Object.assign(data!.archives[idx], updates);
    save();
  }
}

export function createArchive(
  input: Omit<Archive, 'id'> & { id?: number }
): Archive {
  load();
  const archive: Archive = {
    ...input,
    id: input.id ?? nextIds.archives++,
    topics: input.topics ?? [],
  };
  data!.archives.push(archive);
  save();
  return { ...archive };
}

// ── Repos (memberships) ─────────────────────────────────────────

/**
 * Create a membership linking the current (or specified) user to an archive.
 */
export function linkUserToArchive(
  archiveId: number,
  opts: {
    owner_id?: string;
    from_star?: boolean;
    from_owned?: boolean;
    local_description?: string | null;
  } = {}
): Repo {
  load();
  const ownerId = opts.owner_id || uid();
  const existing = data!.repos.find(
    (r) => r.owner_id === ownerId && r.archive_id === archiveId
  );
  if (existing) {
    return hydrateRepo(existing, archiveById(data!, archiveId));
  }

  const membership: RepoMembership = {
    id: nextIds.repos++,
    owner_id: ownerId,
    archive_id: archiveId,
    created_at: new Date().toISOString(),
    from_star: opts.from_star,
    from_owned: opts.from_owned,
    local_description: opts.local_description ?? null,
  };
  data!.repos.push(membership);
  save();
  return hydrateRepo(membership, archiveById(data!, archiveId));
}

/**
 * @deprecated Prefer createArchive + linkUserToArchive / ensure via callers.
 * Kept for simple create paths that already built archive fields.
 */
export function addRepo(
  repo: {
    platform: string;
    owner: string;
    name: string;
    clone_url: string;
    mirror_path: string;
    last_synced_at?: string | null;
    from_star?: boolean;
    from_owned?: boolean;
    owner_id?: string;
    is_private?: boolean;
    local_description?: string | null;
  }
): Repo {
  load();
  const isPrivate = Boolean(repo.is_private);
  let archive: Archive | undefined;
  if (!isPrivate) {
    archive = findPublicArchive(repo.platform, repo.owner, repo.name);
  }
  if (!archive) {
    archive = createArchive({
      platform: repo.platform,
      owner: repo.owner,
      name: repo.name,
      clone_url: repo.clone_url,
      mirror_path: repo.mirror_path,
      last_synced_at: repo.last_synced_at ?? null,
      is_private: isPrivate,
    });
  }
  return linkUserToArchive(archive.id, {
    owner_id: repo.owner_id,
    from_star: repo.from_star,
    from_owned: repo.from_owned,
    local_description: repo.local_description,
  });
}

export function findRepo(
  platform: string,
  owner: string,
  name: string
): Repo | undefined {
  const userId = uid();
  const d = load();
  const key = identityKey(platform, owner, name);
  for (const m of d.repos) {
    if (m.owner_id !== userId) continue;
    const a = archiveById(d, m.archive_id);
    if (a && identityKey(a.platform, a.owner, a.name) === key) {
      return hydrateRepo(m, a);
    }
  }
  return undefined;
}

/**
 * Build a bulk lookup map of (identityKey → { id, archiveId }) for the given
 * user.  Much faster than calling findRepo() in a loop when you need to check
 * many repos (e.g. annotating every star with its archived status).
 */
export function buildRepoLookup(
  userId: string
): Map<string, { id: number; archiveId: number }> {
  const d = load();
  const map = new Map<string, { id: number; archiveId: number }>();
  for (const m of d.repos) {
    if (m.owner_id !== userId) continue;
    const a = archiveById(d, m.archive_id);
    if (a) {
      map.set(identityKey(a.platform, a.owner, a.name), {
        id: m.id,
        archiveId: m.archive_id,
      });
    }
  }
  return map;
}

export function getRepoById(id: number): Repo | undefined {
  const userId = uid();
  const d = load();
  const m = d.repos.find((r) => r.id === id && r.owner_id === userId);
  if (!m) return undefined;
  return hydrateRepo(m, archiveById(d, m.archive_id));
}

/** Membership fields only. */
export type RepoMembershipUpdatableFields = Partial<
  Pick<RepoMembership, 'from_star' | 'from_owned' | 'local_description'>
>;

/** Fields that live on the archive (shared). */
export type RepoArchiveUpdatableFields = ArchiveUpdatableFields;

export type RepoUpdatableFields = RepoMembershipUpdatableFields &
  RepoArchiveUpdatableFields;

/**
 * Update membership and/or archive fields for a membership id.
 * When no ALS user is set, any membership id may be updated (scheduler).
 */
export function updateRepo(id: number, updates: RepoUpdatableFields) {
  load();
  const userId = tryGetUserId();
  const idx = data!.repos.findIndex(
    (r) => r.id === id && (userId ? r.owner_id === userId : true)
  );
  if (idx < 0) return;

  const membershipKeys: (keyof RepoMembershipUpdatableFields)[] = [
    'from_star',
    'from_owned',
    'local_description',
  ];
  const membershipUpdates: RepoMembershipUpdatableFields = {};
  const archiveUpdates: ArchiveUpdatableFields = {};

  for (const [k, v] of Object.entries(updates)) {
    if (membershipKeys.includes(k as keyof RepoMembershipUpdatableFields)) {
      (membershipUpdates as any)[k] = v;
    } else {
      (archiveUpdates as any)[k] = v;
    }
  }

  if (Object.keys(membershipUpdates).length) {
    Object.assign(data!.repos[idx], membershipUpdates);
  }
  if (Object.keys(archiveUpdates).length) {
    const archiveId = data!.repos[idx].archive_id;
    const aidx = data!.archives.findIndex((a) => a.id === archiveId);
    if (aidx >= 0) Object.assign(data!.archives[aidx], archiveUpdates);
  }
  save();
}

/**
 * Unlink current user from a repo membership. Physically deletes the archive
 * (mirror + release files) only when no other members remain.
 * Returns whether the underlying archive was destroyed.
 */
export function unlinkRepo(id: number): {
  unlinked: boolean;
  archiveDeleted: boolean;
  mirrorPath: string | null;
  assetPaths: string[];
} {
  load();
  const userId = uid();
  const membership = data!.repos.find(
    (r) => r.id === id && r.owner_id === userId
  );
  if (!membership) {
    return {
      unlinked: false,
      archiveDeleted: false,
      mirrorPath: null,
      assetPaths: [],
    };
  }

  const archiveId = membership.archive_id;
  const archive = archiveById(data!, archiveId);

  data!.repos = data!.repos.filter((r) => r.id !== id);
  data!.sync_logs = data!.sync_logs.filter((l) => l.repo_id !== id);
  data!.repo_lists = data!.repo_lists.filter((rl) => rl.repo_id !== id);

  const remaining = data!.repos.filter((r) => r.archive_id === archiveId);
  if (remaining.length > 0) {
    save();
    return {
      unlinked: true,
      archiveDeleted: false,
      mirrorPath: null,
      assetPaths: [],
    };
  }

  // Last member — collect asset paths then drop archive content
  const releaseIds = new Set(
    data!.releases.filter((r) => r.archive_id === archiveId).map((r) => r.id)
  );
  const assetPaths = data!.release_assets
    .filter((a) => releaseIds.has(a.release_id) && a.file_path)
    .map((a) => a.file_path!);

  data!.releases = data!.releases.filter((r) => r.archive_id !== archiveId);
  data!.release_assets = data!.release_assets.filter(
    (a) => !releaseIds.has(a.release_id)
  );
  data!.archives = data!.archives.filter((a) => a.id !== archiveId);
  save();

  return {
    unlinked: true,
    archiveDeleted: true,
    mirrorPath: archive?.mirror_path ?? null,
    assetPaths,
  };
}

/** @deprecated Use unlinkRepo — kept name for older call sites. */
export function deleteRepo(id: number) {
  unlinkRepo(id);
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
    if (data!.lists.some((l) => l.id === list_id && l.owner_id === userId)) {
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
  const ownedRepoIds = new Set(ownedMemberships(userId).map((r) => r.id));
  return data!.repo_lists
    .filter((rl) => rl.list_id === listId && ownedRepoIds.has(rl.repo_id))
    .map((rl) => rl.repo_id);
}

export function getListCounts(): Record<number, number> {
  const userId = uid();
  const ownedRepoIds = new Set(ownedMemberships(userId).map((r) => r.id));
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

export function addRelease(
  release: Omit<Release, 'id' | 'created_at'>
): Release {
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
  archiveId: number,
  tagName: string
): Release | undefined {
  load();
  return data!.releases.find(
    (r) => r.archive_id === archiveId && r.tag_name === tagName
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

export function findReleaseAsset(
  releaseId: number,
  assetName: string
): ReleaseAsset | undefined {
  load();
  return data!.release_assets.find(
    (a) => a.release_id === releaseId && a.name === assetName
  );
}

export function updateReleaseAsset(
  id: number,
  updates: Partial<
    Pick<ReleaseAsset, 'file_path' | 'size' | 'content_type' | 'download_url'>
  >
): void {
  load();
  const idx = data!.release_assets.findIndex((a) => a.id === id);
  if (idx < 0) return;
  Object.assign(data!.release_assets[idx], updates);
  save();
}

/** All release assets (unscoped) — used for post-approval download pass. */
export function getAllReleaseAssets(): ReleaseAsset[] {
  return [...load().release_assets];
}

// ── Pending asset-host approvals ────────────────────────────────

export function listPendingAssetHostsForUser(
  userId?: string
): PendingAssetHostApproval[] {
  load();
  const uid = userId ?? tryGetUserId() ?? AUTOLOGIN_USER_ID;
  const list = data!.pending_asset_host_approvals_by_user[uid] || [];
  return list.map((p) => ({ ...p }));
}

/**
 * Upsert a pending host approval for the current user.
 * @returns true if newly added (or sample_url refreshed)
 */
export function upsertPendingAssetHost(
  pending: PendingAssetHostApproval
): boolean {
  load();
  const uid = tryGetUserId() ?? AUTOLOGIN_USER_ID;
  if (!data!.pending_asset_host_approvals_by_user[uid]) {
    data!.pending_asset_host_approvals_by_user[uid] = [];
  }
  const list = data!.pending_asset_host_approvals_by_user[uid];
  const host = pending.hostname.toLowerCase();
  const existing = list.find((p) => p.hostname.toLowerCase() === host);
  if (existing) {
    // Keep earliest first_seen; refresh sample context
    existing.sample_url = pending.sample_url;
    existing.repo_label = pending.repo_label;
    save();
    return false;
  }
  list.push({
    hostname: host,
    sample_url: pending.sample_url,
    repo_label: pending.repo_label,
    first_seen_at: pending.first_seen_at,
  });
  // Cap queue so a hostile remote can't fill db.json
  if (list.length > 50) {
    list.splice(0, list.length - 50);
  }
  save();
  return true;
}

export function removePendingAssetHost(hostname: string, userId?: string): void {
  load();
  const uid = userId ?? tryGetUserId() ?? AUTOLOGIN_USER_ID;
  const list = data!.pending_asset_host_approvals_by_user[uid];
  if (!list) return;
  const host = hostname.toLowerCase();
  data!.pending_asset_host_approvals_by_user[uid] = list.filter(
    (p) => p.hostname.toLowerCase() !== host
  );
  save();
}

export function tagExists(archiveId: number, tagName: string): boolean {
  load();
  return data!.releases.some(
    (r) => r.archive_id === archiveId && r.tag_name === tagName
  );
}

/** Count releases for an archive (unscoped). */
export function countArchiveReleases(archiveId: number): number {
  return load().releases.filter((r) => r.archive_id === archiveId).length;
}
