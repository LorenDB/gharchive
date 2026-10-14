/**
 * Cached recursive directory sizes.
 *
 * A full walk of mirrors/ is O(files on disk) and must never run inline on a
 * request path. Readers get the cached value synchronously (stale-while-
 * revalidate); refreshes happen in the background via the fs threadpool.
 */
import fs from 'fs';
import path from 'path';

const TTL_MS = 60_000;

type Entry = { bytes: number; at: number };
const cache = new Map<string, Entry>();
const inflight = new Set<string>();

function walkSync(dirPath: string, depth = 0): number {
  // Bound depth + skip symlinks: a malicious mirror with a symlink loop must
  // not wedge the event loop on cold-cache walks.
  if (depth > 25) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += walkSync(full, depth + 1);
      else total += fs.lstatSync(full).size;
    } catch {
      // unreadable / vanished mid-walk
    }
  }
  return total;
}

async function walkAsync(dirPath: string, depth = 0): Promise<number> {
  if (depth > 25) return 0;
  let total = 0;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await walkAsync(full, depth + 1);
    } else {
      try {
        total += (await fs.promises.lstat(full)).size;
      } catch {
        // file vanished mid-walk
      }
    }
  }
  return total;
}

/**
 * Directory size for display. Returns the cached value when available
 * (refreshing in the background if past TTL); only a cold cache performs
 * a synchronous walk.
 */
export function getCachedDirSize(dirPath: string): number {
  if (!dirPath) return 0;
  const cached = cache.get(dirPath);
  if (cached) {
    if (Date.now() - cached.at >= TTL_MS) {
      refreshDirSizeAsync(dirPath);
    }
    return cached.bytes;
  }
  let bytes = 0;
  try {
    if (fs.existsSync(dirPath)) bytes = walkSync(dirPath);
  } catch {
    // unreadable dir → 0
  }
  cache.set(dirPath, { bytes, at: Date.now() });
  return bytes;
}

/** Background refresh via the fs threadpool; coalesces concurrent requests. */
export function refreshDirSizeAsync(dirPath: string): void {
  if (!dirPath || inflight.has(dirPath)) return;
  inflight.add(dirPath);
  walkAsync(dirPath)
    .then((bytes) => {
      cache.set(dirPath, { bytes, at: Date.now() });
    })
    .catch(() => {
      // keep last known value on failure
    })
    .finally(() => {
      inflight.delete(dirPath);
    });
}

/** Drop a cached size (e.g. after the directory changed on disk). */
export function invalidateDirSize(dirPath: string): void {
  cache.delete(dirPath);
}

/** Kick off background refreshes for many paths at once (startup prewarm). */
export function prewarmDirSizes(dirPaths: string[]): void {
  for (const p of dirPaths) refreshDirSizeAsync(p);
}
