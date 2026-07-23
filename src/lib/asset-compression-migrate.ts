/**
 * Background job: rewrite on-disk release assets to match the compress setting.
 *
 * - target compress=true  → gzip eligible raw assets (skip known archives)
 * - target compress=false → gunzip storage-compressed assets back to raw
 *
 * In-process only (survives neither multi-instance nor process restart).
 * Modeled after the star-import job state machine.
 */

import fs from 'fs';
import path from 'path';
import {
  compressForStorage,
  decompressFromStorage,
  isAlreadyCompressedArchive,
  isAssetStorageCompressed,
  logicalAssetPath,
  shouldCompressAsset,
  storageCompressedPath,
} from '@/lib/asset-compression';
import {
  getAllReleaseAssets,
  getSettings,
  updateReleaseAsset,
  updateSettings,
} from '@/lib/db';
import { hasEnoughMemory } from '@/lib/memory';
import { getReleasesRoot, isPathInside } from '@/lib/safe-url';

export type CompressMigrateJobStatus = {
  running: boolean;
  /** Snapshot of the compression target when the job started. */
  target_compress: boolean | null;
  total: number;
  processed: number;
  converted: number;
  skipped: number;
  failed: number;
  current: string | null;
  errors: { asset: string; error: string }[];
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
};

type JobState = CompressMigrateJobStatus & {
  cancelled: boolean;
};

const g = globalThis as typeof globalThis & {
  __gharchiveCompressMigrateJob?: JobState;
};

function job(): JobState {
  if (!g.__gharchiveCompressMigrateJob) {
    g.__gharchiveCompressMigrateJob = {
      running: false,
      target_compress: null,
      total: 0,
      processed: 0,
      converted: 0,
      skipped: 0,
      failed: 0,
      current: null,
      errors: [],
      started_at: null,
      finished_at: null,
      message: null,
      cancelled: false,
    };
  }
  return g.__gharchiveCompressMigrateJob;
}

export function getCompressMigrateStatus(): CompressMigrateJobStatus {
  const j = job();
  return {
    running: j.running,
    target_compress: j.target_compress,
    total: j.total,
    processed: j.processed,
    converted: j.converted,
    skipped: j.skipped,
    failed: j.failed,
    current: j.current,
    errors: j.errors.slice(0, 50),
    started_at: j.started_at,
    finished_at: j.finished_at,
    message: j.message,
  };
}

export function cancelCompressMigrate(): CompressMigrateJobStatus {
  const j = job();
  if (j.running) {
    j.cancelled = true;
    j.message = 'Cancelling…';
  }
  return getCompressMigrateStatus();
}

export type MigrateAssetInput = {
  id: number;
  name: string;
  file_path: string | null;
  storage_compressed?: boolean | null;
};

export type MigrateAssetResult = 'converted' | 'skipped' | 'failed';

/**
 * Convert a single asset file toward the target compression policy.
 * Pure-ish: updates the DB row when conversion succeeds.
 */
export function migrateOneAsset(
  asset: MigrateAssetInput,
  targetCompress: boolean
): { result: MigrateAssetResult; error?: string } {
  if (!asset.file_path) {
    return { result: 'skipped' };
  }

  const releasesRoot = getReleasesRoot();
  if (!isPathInside(releasesRoot, asset.file_path)) {
    return { result: 'failed', error: 'path outside releases root' };
  }

  let exists = false;
  try {
    exists = fs.existsSync(asset.file_path);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { result: 'skipped' };
  }

  // Reject symlinks
  try {
    if (fs.lstatSync(asset.file_path).isSymbolicLink()) {
      return { result: 'failed', error: 'symlink not allowed' };
    }
  } catch (err: any) {
    return { result: 'failed', error: err?.message || 'stat failed' };
  }

  const currentlyCompressed = isAssetStorageCompressed(
    asset.file_path,
    asset.storage_compressed
  );
  const logical = logicalAssetPath(asset.file_path);

  try {
    if (targetCompress) {
      if (currentlyCompressed) {
        return { result: 'skipped' };
      }
      if (!shouldCompressAsset(asset.name, true)) {
        return { result: 'skipped' };
      }
      // Known archives are never double-compressed
      if (isAlreadyCompressedArchive(asset.name)) {
        return { result: 'skipped' };
      }

      const raw = fs.readFileSync(asset.file_path);
      const gz = compressForStorage(raw);
      if (!gz) {
        // No size win — leave raw, ensure flag is false
        if (asset.storage_compressed) {
          updateReleaseAsset(asset.id, { storage_compressed: false });
        }
        return { result: 'skipped' };
      }

      const outPath = storageCompressedPath(logical);
      if (!isPathInside(releasesRoot, outPath)) {
        return { result: 'failed', error: 'compressed path outside releases root' };
      }

      const tmp = outPath + '.tmp';
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, outPath);

      if (path.resolve(asset.file_path) !== path.resolve(outPath)) {
        try {
          fs.unlinkSync(asset.file_path);
        } catch {
          // best-effort
        }
      }

      updateReleaseAsset(asset.id, {
        file_path: outPath,
        storage_compressed: true,
      });
      return { result: 'converted' };
    }

    // targetCompress === false → decompress storage layer
    if (!currentlyCompressed) {
      return { result: 'skipped' };
    }

    const compressed = fs.readFileSync(asset.file_path);
    let raw: Buffer;
    try {
      raw = decompressFromStorage(compressed);
    } catch (err: any) {
      return {
        result: 'failed',
        error: err?.message || 'gunzip failed',
      };
    }

    if (!isPathInside(releasesRoot, logical)) {
      return { result: 'failed', error: 'logical path outside releases root' };
    }

    const tmp = logical + '.tmp';
    fs.mkdirSync(path.dirname(logical), { recursive: true });
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, logical);

    if (path.resolve(asset.file_path) !== path.resolve(logical)) {
      try {
        fs.unlinkSync(asset.file_path);
      } catch {
        // best-effort
      }
    }

    updateReleaseAsset(asset.id, {
      file_path: logical,
      storage_compressed: false,
    });
    return { result: 'converted' };
  } catch (err: any) {
    return { result: 'failed', error: err?.message || String(err) };
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runMigrateLoop(targetCompress: boolean): Promise<void> {
  const j = job();
  const assets = getAllReleaseAssets().filter((a) => a.file_path);
  j.total = assets.length;
  j.message = targetCompress
    ? 'Compressing eligible assets…'
    : 'Decompressing storage-compressed assets…';

  for (const asset of assets) {
    if (j.cancelled) {
      j.message = 'Cancelled';
      break;
    }

    j.current = asset.name || `asset#${asset.id}`;

    // Defer large files when memory is tight
    try {
      if (asset.file_path && fs.existsSync(asset.file_path)) {
        const size = fs.statSync(asset.file_path).size;
        if (size > 10 * 1024 * 1024) {
          const check = hasEnoughMemory(Math.ceil(size / 1024 / 1024) + 64);
          if (!check.ok) {
            j.skipped++;
            j.processed++;
            if (j.errors.length < 50) {
              j.errors.push({
                asset: j.current,
                error: `deferred (low memory): ${check.reason}`,
              });
            }
            await yieldEventLoop();
            continue;
          }
        }
      }
    } catch {
      // continue and let migrateOneAsset handle
    }

    const { result, error } = migrateOneAsset(asset, targetCompress);
    j.processed++;
    if (result === 'converted') j.converted++;
    else if (result === 'skipped') j.skipped++;
    else {
      j.failed++;
      if (error && j.errors.length < 50) {
        j.errors.push({ asset: j.current, error });
      }
    }

    // Yield so the event loop can serve requests between files
    if (j.processed % 5 === 0) {
      await yieldEventLoop();
    }
  }

  j.current = null;
  j.running = false;
  j.finished_at = new Date().toISOString();
  if (!j.cancelled) {
    j.message =
      j.failed > 0
        ? `Done with ${j.failed} error(s): ${j.converted} converted, ${j.skipped} skipped`
        : `Done: ${j.converted} converted, ${j.skipped} skipped`;
  }
  j.cancelled = false;
}

export type StartCompressMigrateOptions = {
  /**
   * Target policy. When omitted, uses current saved settings.
   * When provided, also persists the setting so future downloads match.
   */
  compress_release_assets?: boolean;
};

/**
 * Start the migration job. Returns status immediately; work continues in background.
 * @throws if a job is already running
 */
export function startCompressMigrate(
  options: StartCompressMigrateOptions = {}
): CompressMigrateJobStatus {
  const j = job();
  if (j.running) {
    throw new Error('A compression migration is already running');
  }

  let target: boolean;
  if (typeof options.compress_release_assets === 'boolean') {
    target = options.compress_release_assets;
    updateSettings({ compress_release_assets: target });
  } else {
    target = Boolean(getSettings().compress_release_assets);
  }

  j.running = true;
  j.cancelled = false;
  j.target_compress = target;
  j.total = 0;
  j.processed = 0;
  j.converted = 0;
  j.skipped = 0;
  j.failed = 0;
  j.current = null;
  j.errors = [];
  j.started_at = new Date().toISOString();
  j.finished_at = null;
  j.message = 'Starting…';

  // Fire-and-forget; errors are recorded on the job state
  void runMigrateLoop(target).catch((err) => {
    const st = job();
    st.running = false;
    st.finished_at = new Date().toISOString();
    st.message = `Failed: ${err?.message || String(err)}`;
    st.cancelled = false;
  });

  return getCompressMigrateStatus();
}
