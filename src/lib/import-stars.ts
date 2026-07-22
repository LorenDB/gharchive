import {
  findRepo,
  findPublicArchive,
  createArchive,
  linkUserToArchive,
  upsertGithubList,
  addRepoToList,
  setRepoLists,
  getListByGithubId,
  getListByName,
  ensureLocalList,
  touchGithubImport,
  touchGithubScan,
  getGithubToken,
  getSettings,
  type List,
} from '@/lib/db';
import { getMirrorPath, cloneMirror } from '@/lib/git';
import { syncRepo } from '@/lib/sync';
import {
  fetchStarsPreview,
  fetchOwnedRepos,
  type GhStarredRepo,
  type GhOwnedRepo,
} from '@/lib/github';
import {
  getRequiredUserId,
  runAsUserAsync,
  tryGetUserId,
} from '@/lib/user-context';
import { hasEnoughMemory } from '@/lib/memory';

export interface ImportItem {
  owner: string;
  name: string;
  clone_url: string;
  platform?: 'github' | 'gitlab';
  /** GitHub list GraphQL ids to assign (may be empty = unlisted / no list) */
  github_list_ids: string[];
  /** Local list names to ensure/create and assign (optional) */
  local_list_names?: string[];
  from_star?: boolean;
  from_owned?: boolean;
  /** When true, never share the archive across users */
  is_private?: boolean;
  /** User who enqueued this item (for round-robin scheduling) */
  userId?: string;
}

export const PENDING_PHASES = ['queued', 'cloning', 'releases'] as const;
export type PendingPhase = (typeof PENDING_PHASES)[number];

export interface PendingItem {
  owner: string;
  name: string;
  clone_url: string;
  platform: 'github' | 'gitlab';
  phase: PendingPhase;
  detail: string | null;
  userId: string;
}

export interface ImportJobStatus {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current: string | null;
  errors: { repo: string; error: string }[];
  started_at: string | null;
  finished_at: string | null;
  source: string | null;
  pending_items: PendingItem[];
}

type JobState = ImportJobStatus & {
  queue: ImportItem[];
  listMap: Map<string, List>;
  /** User who started the job — all db ops run as this user */
  userId: string | null;
  /** Last user served — for round-robin scheduling across users */
  lastServedUser: string | null;
  /** Set to true to cancel a running job */
  cancelled: boolean;
  /** Per-item progress tracking. Keyed by `owner/name`. */
  _pending: Map<string, PendingItem>;
};

const g = globalThis as typeof globalThis & {
  __gharchiveImportJob?: JobState;
};

function job(): JobState {
  if (!g.__gharchiveImportJob) {
    g.__gharchiveImportJob = {
      running: false,
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: null,
      errors: [],
      started_at: null,
      finished_at: null,
      source: null,
      pending_items: [],
      queue: [],
      listMap: new Map(),
      userId: null,
      lastServedUser: null,
      cancelled: false,
      _pending: new Map(),
    };
  }
  const j = g.__gharchiveImportJob;
  if (!j._pending) j._pending = new Map();
  return j;
}

export function getImportStatus(): ImportJobStatus {
  const j = job();
  return {
    running: j.running,
    total: j.total,
    completed: j.completed,
    failed: j.failed,
    skipped: j.skipped,
    current: j.current,
    errors: j.errors,
    started_at: j.started_at,
    finished_at: j.finished_at,
    source: j.source,
    pending_items: [...j._pending.values()],
  };
}

export function cancelImport(): ImportJobStatus {
  const j = job();
  if (j.running) {
    j.cancelled = true;
    j.queue = [];
    j._pending.clear();
  }
  return getImportStatus();
}

export function getPendingItems(userId?: string): PendingItem[] {
  const j = job();
  const all = [...j._pending.values()];
  if (!userId) return all;
  return all.filter((p) => p.userId === userId);
}

function setPendingItem(fullName: string, item: PendingItem) {
  const j = job();
  j._pending.set(fullName, item);
}

function removePendingItem(fullName: string) {
  const j = job();
  j._pending.delete(fullName);
}

export function ensureGithubLists(
  lists: { id: string; name: string; description: string | null }[]
): Map<string, List> {
  const map = new Map<string, List>();
  for (const l of lists) {
    const local = upsertGithubList({
      github_list_id: l.id,
      name: l.name,
      description: l.description,
    });
    map.set(l.id, local);
  }
  return map;
}

/** Enqueue a single repo into the import queue. If a job is already running,
 *  the repo is prepended to run next. Otherwise a new job is started. */
export function enqueueRepoImport(item: ImportItem): ImportJobStatus {
  const j = job();
  const userId = getRequiredUserId();
  item.userId = userId;
  item.platform = item.platform || 'github';

  const fullName = `${item.owner}/${item.name}`;

  if (j.running) {
    j.queue.unshift(item);
    j.total++;
    setPendingItem(fullName, {
      owner: item.owner,
      name: item.name,
      clone_url: item.clone_url,
      platform: item.platform,
      phase: 'queued',
      detail: null,
      userId,
    });
    return getImportStatus();
  }

  j.running = true;
  j.total = 1;
  j.completed = 0;
  j.failed = 0;
  j.skipped = 0;
  j.current = null;
  j.errors = [];
  j.started_at = new Date().toISOString();
  j.finished_at = null;
  j.source = 'manual-single';
  j.userId = userId;
  j.lastServedUser = null;
  j.cancelled = false;
  j.queue = [item];
  j.listMap = new Map();
  j._pending = new Map();

  setPendingItem(fullName, {
    owner: item.owner,
    name: item.name,
    clone_url: item.clone_url,
    platform: item.platform,
    phase: 'queued',
    detail: null,
    userId,
  });

  processQueue()
    .catch((err) => {
      console.error('[import] fatal:', err);
      j.running = false;
      j.finished_at = new Date().toISOString();
    });

  return getImportStatus();
}

export function startStarImport(
  items: ImportItem[],
  githubLists: { id: string; name: string; description: string | null }[],
  source = 'manual-stars'
): ImportJobStatus {
  const j = job();
  if (j.running) {
    throw new Error('An import is already running');
  }
  if (items.length === 0) {
    throw new Error('No repositories selected');
  }

  const userId = getRequiredUserId();

  j.running = true;
  j.total = items.length;
  j.completed = 0;
  j.failed = 0;
  j.skipped = 0;
  j.current = null;
  j.errors = [];
  j.started_at = new Date().toISOString();
  j.finished_at = null;
  j.source = source;
  j.userId = userId;
  j.lastServedUser = null;
  j.cancelled = false;
  j.queue = items.map((i) => ({ ...i, userId: i.userId ?? userId, from_star: i.from_star ?? true }));
  j.listMap = ensureGithubLists(githubLists);
  j._pending = new Map();

  for (const item of j.queue) {
    const fullName = `${item.owner}/${item.name}`;
    setPendingItem(fullName, {
      owner: item.owner,
      name: item.name,
      clone_url: item.clone_url,
      platform: item.platform || 'github',
      phase: 'queued',
      detail: null,
      userId: item.userId || userId,
    });
  }

  processQueue()
    .then(() => {
      if (source.includes('star')) {
        return runAsUserAsync(userId, async () => {
          touchGithubImport();
        });
      }
    })
    .catch((err) => {
      console.error('[import] fatal:', err);
      j.running = false;
      j.finished_at = new Date().toISOString();
    });

  return getImportStatus();
}

/** Awaitable import for scheduler (skips if a job is already running). */
export async function runImportAwait(
  items: ImportItem[],
  githubLists: { id: string; name: string; description: string | null }[],
  source: string
): Promise<ImportJobStatus> {
  const j = job();
  if (j.running) {
    return {
      ...getImportStatus(),
    };
  }
  if (items.length === 0) {
    return {
      running: false,
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: null,
      errors: [],
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      source,
      pending_items: [],
    };
  }

  const userId = tryGetUserId() ?? getRequiredUserId();

  j.running = true;
  j.total = items.length;
  j.completed = 0;
  j.failed = 0;
  j.skipped = 0;
  j.current = null;
  j.errors = [];
  j.started_at = new Date().toISOString();
  j.finished_at = null;
  j.source = source;
  j.userId = userId;
  j.lastServedUser = null;
  j.cancelled = false;
  j.queue = items.map((i) => ({ ...i, userId: i.userId ?? userId }));
  j.listMap = ensureGithubLists(githubLists);
  j._pending = new Map();

  for (const item of j.queue) {
    const fullName = `${item.owner}/${item.name}`;
    setPendingItem(fullName, {
      owner: item.owner,
      name: item.name,
      clone_url: item.clone_url,
      platform: item.platform || 'github',
      phase: 'queued',
      detail: null,
      userId: item.userId || userId,
    });
  }

  try {
    await processQueue();
  } catch (err) {
    console.error('[import] fatal:', err);
    j.running = false;
    j.finished_at = new Date().toISOString();
  }

  return getImportStatus();
}

/** Pick the next queue item using round-robin across users for fairness. */
function pickNextItem(): ImportItem | undefined {
  const j = job();
  if (j.queue.length === 0) return undefined;

  const userItems = new Map<string, number[]>();
  for (let i = 0; i < j.queue.length; i++) {
    const uid = j.queue[i].userId || j.userId || 'unknown';
    const arr = userItems.get(uid);
    if (arr) arr.push(i);
    else userItems.set(uid, [i]);
  }

  const userIds = [...userItems.keys()];
  if (userIds.length <= 1) {
    j.lastServedUser = userIds[0] || null;
    return j.queue.shift()!;
  }

  const lastIdx = j.lastServedUser ? userIds.indexOf(j.lastServedUser) : -1;
  const startIdx = (lastIdx + 1) % userIds.length;

  for (let attempt = 0; attempt < userIds.length; attempt++) {
    const candidateUser = userIds[(startIdx + attempt) % userIds.length];
    const indices = userItems.get(candidateUser);
    if (indices && indices.length > 0) {
      const idx = indices[0];
      j.lastServedUser = candidateUser;
      const [item] = j.queue.splice(idx, 1);
      return item;
    }
  }

  return j.queue.shift()!;
}

async function processQueue() {
  const j = job();
  if (!j.userId && j.queue.length === 0) {
    j.running = false;
    j.finished_at = new Date().toISOString();
    throw new Error('Import job missing userId');
  }

  while (j.queue.length > 0) {
    if (j.cancelled) break;

    const item = pickNextItem()!;
    const itemUserId = item.userId || j.userId;
    if (!itemUserId) {
      j.failed++;
      j.errors.push({
        repo: `${item.owner}/${item.name}`,
        error: 'Import item missing userId',
      });
      continue;
    }

    await runAsUserAsync(itemUserId, async () => {
      const settings = getSettings();

      if (settings.memory_aware_enabled) {
        const memCheck = hasEnoughMemory();
        if (!memCheck.ok) {
          j.current = `paused (${memCheck.reason})`;
          // Re-queue this item and wait
          j.queue.unshift(item);
          await new Promise((r) => setTimeout(r, 30_000));
          return;
        }
      }

      const full = `${item.owner}/${item.name}`;
      j.current = full;

      try {
        await importOne(item, j.listMap);
        j.completed++;
      } catch (err: any) {
        if (err?.code === 'SKIPPED') {
          j.skipped++;
        } else {
          j.failed++;
          j.errors.push({ repo: full, error: err?.message || String(err) });
          console.error(`[import] ${full}:`, err?.message || err);
        }
        removePendingItem(full);
      }
    });
  }

  j.current = j.cancelled ? 'cancelled' : null;
  j.running = false;
  j.finished_at = new Date().toISOString();
  if (j.cancelled) {
    j._pending.clear();
  }
}

async function importOne(item: ImportItem, listMap: Map<string, List>) {
  const existing = findRepo('github', item.owner, item.name);
  const fullName = `${item.owner}/${item.name}`;
  const platform = item.platform || 'github';

  const setPhase = (phase: PendingPhase, detail: string | null = null) => {
    const current = job()._pending.get(fullName);
    if (current) {
      current.phase = phase;
      current.detail = detail;
    }
  };

  const listIds: number[] = [];
  for (const gid of item.github_list_ids) {
    const cached = listMap.get(gid);
    const local =
      getListByGithubId(gid) ||
      (cached && cached.owner_id === tryGetUserId() ? cached : undefined);
    if (local) listIds.push(local.id);
  }
  for (const name of item.local_list_names || []) {
    let local = getListByName(name);
    if (!local) {
      local = ensureLocalList(
        name,
        name === 'Owned' ? 'Repositories you own on GitHub' : null,
        name === 'Owned' ? '#6ea8fe' : '#e8b44a'
      );
    }
    listIds.push(local.id);
  }

  if (existing) {
    if (listIds.length) {
      for (const lid of listIds) addRepoToList(existing.id, lid);
    }
    removePendingItem(fullName);
    const err: any = new Error('Already archived — lists updated');
    err.code = 'SKIPPED';
    throw err;
  }

  const cloneUrl =
    item.clone_url || `https://github.com/${item.owner}/${item.name}.git`;
  const isPrivate = Boolean(item.is_private);

  let repo;
  let linkedOnly = false;

  if (!isPrivate) {
    const shared = findPublicArchive('github', item.owner, item.name);
    if (shared) {
      repo = linkUserToArchive(shared.id, {
        from_star: Boolean(item.from_star),
        from_owned: Boolean(item.from_owned),
      });
      linkedOnly = true;
    }
  }

  if (!repo) {
    setPhase('cloning');
    const mirrorPath = getMirrorPath('github', item.owner, item.name, {
      isPrivate,
      userId: tryGetUserId() || undefined,
    });
    await cloneMirror(cloneUrl, mirrorPath);
    const archive = createArchive({
      platform: 'github',
      owner: item.owner,
      name: item.name,
      clone_url: cloneUrl,
      mirror_path: mirrorPath,
      last_synced_at: null,
      is_private: isPrivate,
    });
    repo = linkUserToArchive(archive.id, {
      from_star: Boolean(item.from_star),
      from_owned: Boolean(item.from_owned),
    });
  }

  if (listIds.length) {
    setRepoLists(repo.id, listIds);
  }

  setPhase('releases');
  try {
    await syncRepo(repo, {
      skipGit: !linkedOnly,
      onProgress: (detail) => setPhase('releases', detail),
    });
  } catch (e: any) {
    console.warn(
      `[import] release sync for ${item.owner}/${item.name}:`,
      e?.message
    );
  }

  removePendingItem(fullName);
}

export function itemsFromSelection(
  stars: GhStarredRepo[],
  selectedFullNames: string[],
  membership: Record<string, string[]>
): ImportItem[] {
  const want = new Set(selectedFullNames);
  return stars
    .filter((s) => want.has(s.full_name))
    .map((s) => ({
      owner: s.owner,
      name: s.name,
      clone_url: s.clone_url,
      github_list_ids: membership[s.full_name] || [],
      from_star: true,
      is_private: Boolean(s.private),
    }));
}

export function itemsFromOwned(repos: GhOwnedRepo[]): ImportItem[] {
  return repos.map((r) => ({
    owner: r.owner,
    name: r.name,
    clone_url: r.clone_url,
    github_list_ids: [],
    local_list_names: ['Owned'],
    from_owned: true,
    is_private: Boolean(r.private),
  }));
}

export function requireGithubToken(): string {
  const t = getGithubToken();
  if (!t) throw new Error('Link a GitHub account first');
  return t;
}

export interface ScanResult {
  kind: 'stars' | 'owned';
  scanned: number;
  missing: number;
  imported: number;
  skipped: number;
  failed: number;
  message: string;
}

/**
 * Scan GitHub stars; optionally auto-import missing mirrors.
 * Always refreshes star-list membership for already-archived stars when possible.
 */
export async function scanAndMaybeImportStars(
  opts: { forceImport?: boolean } = {}
): Promise<ScanResult> {
  const settings = getSettings();
  const token = requireGithubToken();
  const preview = await fetchStarsPreview(token);

  // Ensure GH lists exist locally even if we only refresh membership
  ensureGithubLists(
    preview.lists.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
    }))
  );

  const missing = preview.stars.filter(
    (s) => !findRepo('github', s.owner, s.name)
  );

  // Refresh list membership for already-archived stars
  for (const s of preview.stars) {
    const existing = findRepo('github', s.owner, s.name);
    if (!existing) continue;
    const gids = preview.membership[s.full_name] || [];
    for (const gid of gids) {
      const local = getListByGithubId(gid);
      if (local) addRepoToList(existing.id, local.id);
    }
  }

  const shouldImport = Boolean(
    opts.forceImport ?? settings.auto_import_stars_enabled
  );

  if (!shouldImport || missing.length === 0) {
    touchGithubScan('stars', { imported: false });
    return {
      kind: 'stars',
      scanned: preview.stars.length,
      missing: missing.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      message: shouldImport
        ? `stars: ${preview.stars.length} scanned, none new`
        : `stars: ${preview.stars.length} scanned, ${missing.length} missing (auto-import off)`,
    };
  }

  const items = itemsFromSelection(
    preview.stars,
    missing.map((m) => m.full_name),
    preview.membership
  );

  const status = await runImportAwait(
    items,
    preview.lists.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
    })),
    'auto-stars'
  );

  touchGithubScan('stars', { imported: status.completed > 0 });

  return {
    kind: 'stars',
    scanned: preview.stars.length,
    missing: missing.length,
    imported: status.completed,
    skipped: status.skipped,
    failed: status.failed,
    message: `stars: imported ${status.completed}, skipped ${status.skipped}, failed ${status.failed}`,
  };
}

/**
 * Scan repositories owned by the linked account; optionally auto-import.
 */
export async function scanAndMaybeImportOwned(
  opts: { forceImport?: boolean } = {}
): Promise<ScanResult> {
  const settings = getSettings();
  const token = requireGithubToken();
  const owned = await fetchOwnedRepos(token, {
    includeForks: settings.auto_import_owned_include_forks,
    includePrivate: settings.auto_import_owned_include_private,
  });

  ensureLocalList('Owned', 'Repositories you own on GitHub', '#6ea8fe');

  const missing = owned.filter((r) => !findRepo('github', r.owner, r.name));

  // Tag already-archived owned repos
  for (const r of owned) {
    const existing = findRepo('github', r.owner, r.name);
    if (!existing) continue;
    const ownedList = getListByName('Owned');
    if (ownedList) addRepoToList(existing.id, ownedList.id);
  }

  const shouldImport = Boolean(
    opts.forceImport ?? settings.auto_import_owned_enabled
  );

  if (!shouldImport || missing.length === 0) {
    touchGithubScan('owned', { imported: false });
    return {
      kind: 'owned',
      scanned: owned.length,
      missing: missing.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      message: shouldImport
        ? `owned: ${owned.length} scanned, none new`
        : `owned: ${owned.length} scanned, ${missing.length} missing (auto-import off)`,
    };
  }

  const items = itemsFromOwned(missing);
  const status = await runImportAwait(items, [], 'auto-owned');

  touchGithubScan('owned', { imported: status.completed > 0 });

  return {
    kind: 'owned',
    scanned: owned.length,
    missing: missing.length,
    imported: status.completed,
    skipped: status.skipped,
    failed: status.failed,
    message: `owned: imported ${status.completed}, skipped ${status.skipped}, failed ${status.failed}`,
  };
}
