export async function register() {
  // Only start the in-process scheduler on the Node.js server runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Warm db.json into memory before the first request
    const { warmDb } = await import('./lib/db');
    try {
      warmDb();
    } catch (err) {
      console.error('[startup] failed to load db.json:', err);
    }

    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
