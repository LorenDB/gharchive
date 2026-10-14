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
      if (pruned > 0) {
        console.log(
          `[startup] autoprune dropped ${pruned} release asset(s) outside retention policy`
        );
      }
    } catch (err) {
      console.error('[startup] autoprune failed:', err);
    }

    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
