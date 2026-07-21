import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export interface DiskInfo {
  /** Absolute path being measured (DATA_DIR) */
  path: string;
  totalMB: number;
  freeMB: number;
  usedMB: number;
  /** 0–1 */
  usageRatio: number;
  available: boolean;
}

/**
 * Disk usage for the DATA_DIR filesystem.
 * Prefers Node's `fs.statfs` (18.15+); falls back to `df -k`.
 */
export async function getDiskInfo(targetPath = DATA_DIR): Promise<DiskInfo> {
  const resolved = path.resolve(targetPath);

  // Ensure the directory exists so statfs/df have something to probe
  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  } catch {
    // ignore — probe may still work on parent
  }

  const fromStatfs = tryStatfs(resolved);
  if (fromStatfs) return fromStatfs;

  const fromDf = await tryDf(resolved);
  if (fromDf) return fromDf;

  return {
    path: resolved,
    totalMB: 0,
    freeMB: 0,
    usedMB: 0,
    usageRatio: 0,
    available: false,
  };
}

function tryStatfs(resolved: string): DiskInfo | null {
  try {
    // Node 18.15+ / 19+
    const statfs = (fs as typeof fs & {
      statfsSync?: (p: string) => {
        bsize: number;
        blocks: number;
        bfree: number;
        bavail: number;
      };
    }).statfsSync;

    if (typeof statfs !== 'function') return null;

    const s = statfs(resolved);
    const block = s.bsize || 0;
    if (!block || !s.blocks) return null;

    const totalBytes = s.blocks * block;
    // Prefer bavail (non-root free) when present
    const freeBytes = (s.bavail ?? s.bfree) * block;
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return toInfo(resolved, totalBytes, freeBytes, usedBytes);
  } catch {
    return null;
  }
}

async function tryDf(resolved: string): Promise<DiskInfo | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-k', resolved], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    // Filesystem 1K-blocks Used Available Use% Mounted on
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return null;
    // Handle wrapped lines: take the last non-header line
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.trim().split(/\s+/);
    // When filesystem name is long, columns may shift; take last 5 numeric-ish fields
    // Expected: [fs, 1k-blocks, used, avail, use%, mount...]
    if (parts.length < 4) return null;

    let totalK: number;
    let usedK: number;
    let availK: number;

    if (parts.length >= 6 && /^\d+$/.test(parts[1])) {
      totalK = parseInt(parts[1], 10);
      usedK = parseInt(parts[2], 10);
      availK = parseInt(parts[3], 10);
    } else {
      // First field empty (wrapped FS name) — numbers start at index 0
      const nums = parts.filter((p) => /^\d+$/.test(p));
      if (nums.length < 3) return null;
      totalK = parseInt(nums[0], 10);
      usedK = parseInt(nums[1], 10);
      availK = parseInt(nums[2], 10);
    }

    if (!Number.isFinite(totalK) || totalK <= 0) return null;

    const totalBytes = totalK * 1024;
    const freeBytes = availK * 1024;
    const usedBytes = usedK * 1024;

    return toInfo(resolved, totalBytes, freeBytes, usedBytes);
  } catch {
    return null;
  }
}

function toInfo(
  resolved: string,
  totalBytes: number,
  freeBytes: number,
  usedBytes: number
): DiskInfo {
  const totalMB = Math.round(totalBytes / 1024 / 1024);
  const freeMB = Math.round(freeBytes / 1024 / 1024);
  const usedMB = Math.round(usedBytes / 1024 / 1024);
  return {
    path: resolved,
    totalMB,
    freeMB,
    usedMB,
    usageRatio: totalMB > 0 ? usedMB / totalMB : 0,
    available: true,
  };
}

export function isStorageLow(
  info: DiskInfo,
  thresholdPercent: number,
  minFreeMB: number
): { low: boolean; reason?: string } {
  if (!info.available || info.totalMB <= 0) {
    return { low: false };
  }

  const usagePct = Math.round(info.usageRatio * 100);
  if (thresholdPercent > 0 && usagePct >= thresholdPercent) {
    return {
      low: true,
      reason: `Disk usage ${usagePct}% ≥ ${thresholdPercent}% (${info.usedMB}/${info.totalMB} MB on ${info.path})`,
    };
  }

  if (minFreeMB > 0 && info.freeMB < minFreeMB) {
    return {
      low: true,
      reason: `Free disk ${info.freeMB} MB < ${minFreeMB} MB on ${info.path}`,
    };
  }

  return { low: false };
}
