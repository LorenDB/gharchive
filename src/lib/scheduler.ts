import { getDb, getSettings } from '@/lib/db';
import { syncRepo } from '@/lib/sync';

/** Check due repos every minute; actual cadence is controlled by settings. */
const TICK_MS = 60_000;

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  started: boolean;
};

// Survive Next.js module duplication (instrumentation vs route bundles)
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
      started: false,
    };
  }
  return g.__gharchiveScheduler;
}

function needsSync(
  lastSyncedAt: string | null,
  intervalHours: number
): boolean {
  if (intervalHours <= 0) return false;
  if (!lastSyncedAt) return true;
  const last = new Date(
    lastSyncedAt.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(lastSyncedAt)
      ? lastSyncedAt
      : lastSyncedAt + 'Z'
  ).getTime();
  const due = last + intervalHours * 3600_000;
  return Date.now() >= due;
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
    : repos.filter((r) =>
        needsSync(r.last_synced_at, settings.sync_interval_hours)
      );

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

async function tick() {
  try {
    const result = await runScheduledSync(false);
    if (result.ran) {
      console.log(`[scheduler] ${result.message}`);
    }
  } catch (err: any) {
    console.error('[scheduler] tick failed:', err?.message || err);
  }
}

export function startScheduler() {
  const s = state();
  if (s.started) return;
  s.started = true;

  // Initial check shortly after boot (let the server finish warming up)
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
    auto_sync_enabled: settings.auto_sync_enabled,
    sync_interval_hours: settings.sync_interval_hours,
  };
}
