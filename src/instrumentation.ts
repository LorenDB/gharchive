export async function register() {
  // Only start the in-process scheduler on the Node.js server runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Warm db.json into memory before the first request
    const { warmDb, pruneAllArchives } = await import('./lib/db');
    try {
      warmDb();
    } catch (err) {
      console.error('[startup] failed to load db.json:', err);
    }

    // Flush release assets left outside the retention policy (e.g. policy
    // tightened while the app was down) before the scheduler starts.
    try {
      const pruned = pruneAllArchives();
      const { listArchives, getAllReleaseAssets } = await import('./lib/db');
      let archives = 0;
      let tracked = 0;
      try {
        archives = listArchives().length;
        tracked = getAllReleaseAssets().length;
      } catch {
        // counts are best-effort
      }
      console.log(
        `[startup] autoprune: ${pruned} asset(s) dropped outside retention ` +
          `(${archives} archives, ${tracked} assets tracked)` +
          (pruned === 0 && tracked > 0
            ? ' — if disk is full, check Settings → release asset mode (prune keeps everything when policy is "all")'
            : '')
      );
    } catch (err) {
      console.error('[startup] autoprune failed:', err);
    }

    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
