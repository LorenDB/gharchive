import {
  getDb,
  getSettings,
  getGithubAccount,
  getGithubToken,
} from '@/lib/db';
import { syncRepo } from '@/lib/sync';
import {
  scanAndMaybeImportStars,
  scanAndMaybeImportOwned,
  getImportStatus,
} from '@/lib/import-stars';

/** Check due work every minute; cadences come from settings. */
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

export async function runScheduledSync(force = false): Promise<{
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

  const settings = getSettings();
  if (!force && !settings.auto_sync_enabled) {
    return {
      ran: false,
      synced: 0,
      failed: 0,
      skipped: 0,
      message: 'Auto-sync is disabled',
    };
  }

  const { repos } = getDb();
  const due = force
    ? repos
    : repos.filter((r) => isDue(r.last_synced_at, settings.sync_interval_hours));

  if (due.length === 0) {
    return {
      ran: false,
      synced: 0,
      failed: 0,
      skipped: repos.length,
      message: 'No repositories due for sync',
    };
  }

  s.running = true;
  let synced = 0;
  let failed = 0;

  try {
    await mapPool(due, settings.concurrent_syncs, async (repo) => {
      try {
        const result = await syncRepo(repo);
        if (result.ok) synced++;
        else failed++;
      } catch {
        failed++;
      }
    });
  } finally {
    s.running = false;
    s.lastRunAt = new Date().toISOString();
    s.lastRunSummary = `synced ${synced}, failed ${failed}, of ${due.length} due`;
  }

  return {
    ran: true,
    synced,
    failed,
    skipped: repos.length - due.length,
    message: s.lastRunSummary!,
  };
}

export async function runScheduledGithubScan(force = false): Promise<{
  ran: boolean;
  messages: string[];
}> {
  const settings = getSettings();
  const token = getGithubToken();
  const account = getGithubAccount();

  if (!token || !account) {
    return { ran: false, messages: ['No linked GitHub account'] };
  }

  if (getImportStatus().running) {
    return { ran: false, messages: ['Import already in progress'] };
  }

  const starsWanted =
    settings.auto_scan_stars_enabled || settings.auto_import_stars_enabled;
  const ownedWanted =
    settings.auto_scan_owned_enabled || settings.auto_import_owned_enabled;

  if (!force && !starsWanted && !ownedWanted) {
    return { ran: false, messages: ['GitHub auto-scan disabled'] };
  }

  const interval = settings.github_scan_interval_hours;
  const messages: string[] = [];
  let ran = false;

  const starsDue =
    force ||
    (starsWanted && isDue(account.last_stars_scan_at, interval));
  const ownedDue =
    force ||
    (ownedWanted && isDue(account.last_owned_scan_at, interval));

  if (starsDue && starsWanted) {
    try {
      // Respect auto_import_* settings; force only skips the interval check
      const result = await scanAndMaybeImportStars();
      messages.push(result.message);
      ran = true;
    } catch (err: any) {
      messages.push(`stars scan failed: ${err?.message || err}`);
      ran = true;
    }
  }

  if (ownedDue && ownedWanted) {
    if (getImportStatus().running) {
      messages.push('owned: skipped (import busy)');
    } else {
      try {
        const result = await scanAndMaybeImportOwned();
        messages.push(result.message);
        ran = true;
      } catch (err: any) {
        messages.push(`owned scan failed: ${err?.message || err}`);
        ran = true;
      }
    }
  }

  if (ran) {
    const s = state();
    s.lastGithubScanAt = new Date().toISOString();
    s.lastGithubScanSummary = messages.join('; ');
  }

  return { ran, messages };
}

async function tick() {
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

  console.log('[scheduler] started (tick every 60s)');
}

export function getSchedulerStatus() {
  const s = state();
  const settings = getSettings();
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
  };
}
