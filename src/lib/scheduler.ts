import { getSettings, listUserIds, DEFAULT_SETTINGS } from '@/lib/db';
import { getGithubAccount, getGithubToken } from '@/lib/db';
import { getDb } from '@/lib/db';
import type { Settings } from '@/lib/db';
import { syncRepo } from '@/lib/sync';
import {
  scanAndMaybeImportStars,
  scanAndMaybeImportOwned,
  getImportStatus,
} from '@/lib/import-stars';
import { runAsUserAsync } from '@/lib/user-context';
import { hasEnoughMemory, getAdjustedConcurrency, getMemoryInfo } from '@/lib/memory';
import { getDiskInfo, isStorageLow } from '@/lib/disk';
import { sendAlert, isAlertsConfigured } from '@/lib/alerts';

/** Check due work every minute; cadences come from per-user settings. */
const TICK_MS = 60_000;

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastGithubScanAt: string | null;
  lastGithubScanSummary: string | null;
  started: boolean;
};

const g = globalThis as typeof globalThis & {
  __gharchiveScheduler?: SchedulerState;
};

function state(): SchedulerState {
  if (!g.__gharchiveScheduler) {
    g.__gharchiveScheduler = {
      timer: null,
      running: false,
      lastRunAt: null,
      lastRunSummary: null,
      lastGithubScanAt: null,
      lastGithubScanSummary: null,
      started: false,
    };
  }
  return g.__gharchiveScheduler;
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const normalized =
    iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : null;
}

function isDue(lastAt: string | null | undefined, intervalHours: number): boolean {
  if (intervalHours <= 0) return false;
  const last = parseTime(lastAt);
  if (last == null) return true;
  return Date.now() >= last + intervalHours * 3600_000;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, concurrency) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await fn(item);
      }
    }
  );
  await Promise.all(workers);
}

export async function runScheduledSync(
  force = false,
  /** When set (e.g. UI "sync now"), only process this user */
  onlyUserId?: string
): Promise<{
  ran: boolean;
  synced: number;
  failed: number;
  skipped: number;
  message: string;
}> {
  const s = state();
  if (s.running) {
    return {
      ran: false,
      synced: 0,
      failed: 0,
      skipped: 0,
      message: 'A sync is already in progress',
    };
  }

  s.running = true;
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let dueTotal = 0;
  const userParts: string[] = [];
  const userIds = onlyUserId ? [onlyUserId] : listUserIds();
  /** Shared public archives: only sync once per tick even if many users link them. */
  const syncedArchiveIds = new Set<number>();

  try {
    for (const userId of userIds) {
      const part = await runAsUserAsync(userId, async () => {
        const settings = getSettings();
        if (!force && !settings.auto_sync_enabled) {
          return { synced: 0, failed: 0, skipped: 0, due: 0, note: 'disabled' };
        }

        const { repos } = getDb();
        const due = force
          ? repos
          : repos.filter((r) =>
              isDue(r.last_synced_at, settings.sync_interval_hours)
            );

        // Skip memberships whose archive was already synced this tick (shared public)
        const work = due.filter((r) => {
          if (syncedArchiveIds.has(r.archive_id)) return false;
          return true;
        });

        let uSynced = 0;
        let uFailed = 0;
        let uSkippedShared = due.length - work.length;

        const adjustedConcurrency = getAdjustedConcurrency(settings.concurrent_syncs);
        if (adjustedConcurrency < 1 && work.length > 0) {
          return {
            synced: 0,
            failed: 0,
            skipped: repos.length,
            due: due.length,
            note: `deferred (low memory)`,
          };
        }

        await mapPool(work, adjustedConcurrency, async (repo) => {
          // Claim archive before sync so concurrent pool workers don't double-fetch
          if (syncedArchiveIds.has(repo.archive_id)) {
            uSkippedShared++;
            return;
          }
          syncedArchiveIds.add(repo.archive_id);
          try {
            const result = await syncRepo(repo);
            if (result.ok) uSynced++;
            else uFailed++;
          } catch {
            uFailed++;
          }
        });

        return {
          synced: uSynced,
          failed: uFailed,
          skipped: repos.length - due.length + uSkippedShared,
          due: due.length,
          note: due.length ? `due ${due.length}` : 'none due',
        };
      });

      synced += part.synced;
      failed += part.failed;
      skipped += part.skipped;
      dueTotal += part.due;
      if (part.due > 0 || part.synced > 0 || part.failed > 0) {
        userParts.push(`${userId.slice(0, 12)}:${part.synced}/${part.failed}`);
      }
    }
  } finally {
    s.running = false;
    s.lastRunAt = new Date().toISOString();
    s.lastRunSummary =
      dueTotal === 0
        ? 'No repositories due for sync'
        : `synced ${synced}, failed ${failed}, of ${dueTotal} due` +
          (userParts.length ? ` [${userParts.join(', ')}]` : '');
  }

  return {
    ran: dueTotal > 0,
    synced,
    failed,
    skipped,
    message: s.lastRunSummary!,
  };
}

export async function runScheduledGithubScan(
  force = false,
  onlyUserId?: string
): Promise<{
  ran: boolean;
  messages: string[];
}> {
  const messages: string[] = [];
  let ran = false;
  const userIds = onlyUserId ? [onlyUserId] : listUserIds();

  for (const userId of userIds) {
    const userMessages = await runAsUserAsync(userId, async () => {
      const settings = getSettings();
      const token = getGithubToken();
      const account = getGithubAccount();
      const out: string[] = [];

      if (!token || !account) {
        return { ran: false, messages: out };
      }

      if (getImportStatus().running) {
        out.push(`${userId.slice(0, 12)}: import busy`);
        return { ran: false, messages: out };
      }

      const starsWanted =
        settings.auto_scan_stars_enabled || settings.auto_import_stars_enabled;
      const ownedWanted =
        settings.auto_scan_owned_enabled || settings.auto_import_owned_enabled;

      if (!force && !starsWanted && !ownedWanted) {
        return { ran: false, messages: out };
      }

      const interval = settings.github_scan_interval_hours;
      let userRan = false;

      const starsDue =
        force || (starsWanted && isDue(account.last_stars_scan_at, interval));
      const ownedDue =
        force || (ownedWanted && isDue(account.last_owned_scan_at, interval));

      if (starsDue && starsWanted) {
        try {
          const result = await scanAndMaybeImportStars();
          out.push(`${userId.slice(0, 12)}: ${result.message}`);
          userRan = true;
        } catch (err: any) {
          out.push(
            `${userId.slice(0, 12)}: stars scan failed: ${err?.message || err}`
          );
          userRan = true;
        }
      }

      if (ownedDue && ownedWanted) {
        if (getImportStatus().running) {
          out.push(`${userId.slice(0, 12)}: owned skipped (import busy)`);
        } else {
          try {
            const result = await scanAndMaybeImportOwned();
            out.push(`${userId.slice(0, 12)}: ${result.message}`);
            userRan = true;
          } catch (err: any) {
            out.push(
              `${userId.slice(0, 12)}: owned scan failed: ${err?.message || err}`
            );
            userRan = true;
          }
        }
      }

      return { ran: userRan, messages: out };
    });

    if (userMessages.ran) ran = true;
    messages.push(...userMessages.messages);
  }

  if (ran) {
    const s = state();
    s.lastGithubScanAt = new Date().toISOString();
    s.lastGithubScanSummary = messages.join('; ') || 'ok';
  }

  if (messages.length === 0 && !ran) {
    return { ran: false, messages: ['No GitHub scans due'] };
  }

  return { ran, messages };
}

/** Per-user system health alerts (storage / memory). */
async function runSystemHealthAlerts(): Promise<void> {
  const disk = await getDiskInfo();
  const mem = getMemoryInfo();

  for (const userId of listUserIds()) {
    await runAsUserAsync(userId, async () => {
      const settings = getSettings();
      if (!isAlertsConfigured(settings)) return;

      if (settings.alert_storage_low && disk.available) {
        const check = isStorageLow(
          disk,
          settings.storage_alert_threshold_percent,
          settings.storage_alert_min_free_mb
        );
        if (check.low) {
          await sendAlert({
            category: 'storage_low',
            title: 'Storage low on GHArchive',
            body: [
              check.reason || 'Disk space is running low.',
              '',
              `| | |`,
              `|---|---|`,
              `| Path | \`${disk.path}\` |`,
              `| Used | ${disk.usedMB} MB (${Math.round(disk.usageRatio * 100)}%) |`,
              `| Free | ${disk.freeMB} MB |`,
              `| Total | ${disk.totalMB} MB |`,
            ].join('\n'),
            subject: 'global',
            severity: 'warning',
          });
        }
      }

      if (settings.alert_memory_low && settings.memory_aware_enabled) {
        const memCheck = hasEnoughMemory();
        if (!memCheck.ok) {
          await sendAlert({
            category: 'memory_low',
            title: 'Memory low on GHArchive',
            body: [
              memCheck.reason || 'Memory is critically low.',
              '',
              `| | |`,
              `|---|---|`,
              `| Free | ${mem.freeMB} MB |`,
              `| Used | ${mem.usedMB} MB (${Math.round(mem.usageRatio * 100)}%) |`,
              `| Total | ${mem.totalMB} MB |`,
              `| Heap | ${mem.heapUsedMB} MB |`,
              mem.cgroupLimited ? `| Limit | cgroup ${mem.cgroupLimitMB} MB |` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            subject: 'global',
            severity: 'warning',
          });
        }
      }
    });
  }
}

async function tick() {
  try {
    await runSystemHealthAlerts();
  } catch (err: any) {
    console.error('[scheduler] health alerts failed:', err?.message || err);
  }

  const memCheck = hasEnoughMemory();
  if (!memCheck.ok) {
    console.log(`[scheduler] skipped tick: ${memCheck.reason}`);
    return;
  }

  try {
    const result = await runScheduledSync(false);
    if (result.ran) {
      console.log(`[scheduler] ${result.message}`);
    }
  } catch (err: any) {
    console.error('[scheduler] sync tick failed:', err?.message || err);
  }

  try {
    const gh = await runScheduledGithubScan(false);
    if (gh.ran) {
      console.log(`[scheduler] github: ${gh.messages.join('; ')}`);
    }
  } catch (err: any) {
    console.error('[scheduler] github scan tick failed:', err?.message || err);
  }
}

export function startScheduler() {
  const s = state();
  if (s.started) return;
  s.started = true;

  setTimeout(() => {
    tick();
  }, 15_000);

  s.timer = setInterval(tick, TICK_MS);
  if (typeof s.timer === 'object' && s.timer && 'unref' in s.timer) {
    (s.timer as NodeJS.Timeout).unref?.();
  }

  console.log('[scheduler] started (tick every 60s, multi-user)');
}

export function getSchedulerStatus() {
  const s = state();
  // Status uses current request user settings when available
  let settings: Settings;
  try {
    settings = getSettings();
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return {
    started: s.started,
    running: s.running,
    last_run_at: s.lastRunAt,
    last_run_summary: s.lastRunSummary,
    last_github_scan_at: s.lastGithubScanAt,
    last_github_scan_summary: s.lastGithubScanSummary,
    auto_sync_enabled: settings.auto_sync_enabled,
    sync_interval_hours: settings.sync_interval_hours,
    auto_scan_stars_enabled: settings.auto_scan_stars_enabled,
    auto_import_stars_enabled: settings.auto_import_stars_enabled,
    auto_scan_owned_enabled: settings.auto_scan_owned_enabled,
    auto_import_owned_enabled: settings.auto_import_owned_enabled,
    github_scan_interval_hours: settings.github_scan_interval_hours,
    memory_aware_enabled: settings.memory_aware_enabled,
    memory_info: getMemoryInfo(),
    adjusted_concurrency: getAdjustedConcurrency(settings.concurrent_syncs),
    alerts_enabled: settings.alerts_enabled,
    alerts_configured: isAlertsConfigured(settings),
  };
}
