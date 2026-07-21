export async function register() {
  // Only start the in-process scheduler on the Node.js server runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
