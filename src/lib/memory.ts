import os from 'os';
import fs from 'fs';
import { getSettings } from '@/lib/db';

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';

export interface MemoryInfo {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  usageRatio: number;
  cgroupLimited: boolean;
  cgroupLimitMB: number | null;
  cgroupUsedMB: number | null;
  heapUsedMB: number;
  heapTotalMB: number;
}

function readCgroupFile(path: string): number | null {
  try {
    const content = fs.readFileSync(path, 'utf8').trim();
    const val = parseInt(content, 10);
    if (!Number.isFinite(val) || val <= 0) return null;
    return val;
  } catch {
    return null;
  }
}

export function getMemoryInfo(): MemoryInfo {
  const heap = process.memoryUsage();
  const heapUsedMB = Math.round(heap.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(heap.heapTotal / 1024 / 1024);

  let cgroupLimit: number | null = readCgroupFile(CGROUP_V2_MAX);
  let cgroupUsed: number | null = null;

  if (cgroupLimit !== null) {
    cgroupUsed = readCgroupFile(CGROUP_V2_CURRENT);
  } else {
    cgroupLimit = readCgroupFile(CGROUP_V1_LIMIT);
    if (cgroupLimit !== null) {
      cgroupUsed = readCgroupFile(CGROUP_V1_USAGE);
    }
  }

  if (cgroupLimit !== null) {
    const limitMB = Math.round(cgroupLimit / 1024 / 1024);
    const usedMB = cgroupUsed !== null
      ? Math.round(cgroupUsed / 1024 / 1024)
      : 0;
    const freeMB = Math.max(0, limitMB - usedMB);

    return {
      totalMB: limitMB,
      freeMB,
      usedMB,
      usageRatio: limitMB > 0 ? usedMB / limitMB : 1,
      cgroupLimited: true,
      cgroupLimitMB: limitMB,
      cgroupUsedMB: usedMB,
      heapUsedMB,
      heapTotalMB,
    };
  }

  const totalMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMB = Math.round(os.freemem() / 1024 / 1024);
  const usedMB = totalMB - freeMB;

  return {
    totalMB,
    freeMB,
    usedMB,
    usageRatio: totalMB > 0 ? usedMB / totalMB : 1,
    cgroupLimited: false,
    cgroupLimitMB: null,
    cgroupUsedMB: null,
    heapUsedMB,
    heapTotalMB,
  };
}

export function hasEnoughMemory(
  minFreeMB?: number,
  maxUsageRatio?: number
): { ok: boolean; reason?: string; info: MemoryInfo } {
  const settings = getSettingsSafe();

  if (!settings.memory_aware_enabled) {
    const info = getMemoryInfo();
    return { ok: true, info };
  }

  const info = getMemoryInfo();
  const requiredFree = minFreeMB ?? settings.min_free_memory_mb;
  const maxRatio = maxUsageRatio ?? settings.max_memory_usage_ratio;

  if (info.freeMB < requiredFree) {
    return {
      ok: false,
      reason: `Free memory ${info.freeMB} MB < minimum ${requiredFree} MB`,
      info,
    };
  }

  const availableRatio = 1 - info.usageRatio;
  const targetFreeRatio = 1 - maxRatio;
  if (availableRatio < targetFreeRatio) {
    return {
      ok: false,
      reason: `Memory usage ${Math.round(info.usageRatio * 100)}% > maximum ${Math.round(maxRatio * 100)}%`,
      info,
    };
  }

  return { ok: true, info };
}

export function getAdjustedConcurrency(desired: number, perWorkerMB = 256): number {
  const settings = getSettingsSafe();

  if (!settings.memory_aware_enabled) return desired;

  const info = getMemoryInfo();
  const safeFree = info.freeMB - settings.min_free_memory_mb;
  if (safeFree <= 0) return 0;

  const maxByMemory = Math.floor(safeFree / perWorkerMB);
  return Math.max(0, Math.min(desired, maxByMemory, settings.concurrent_syncs));
}

export function getMemoryStatusMessage(): string | null {
  const info = getMemoryInfo();
  const settings = getSettingsSafe();

  if (!settings.memory_aware_enabled) return null;

  const parts: string[] = [];
  parts.push(`free ${info.freeMB}/${info.totalMB} MB (${Math.round(info.usageRatio * 100)}%)`);

  if (info.cgroupLimited) {
    parts.push('cgroup-limited');
  }

  if (!hasEnoughMemory().ok) {
    parts.push('LOW MEMORY');
  }

  return parts.join(' ');
}

function getSettingsSafe() {
  try {
    return getSettings();
  } catch {
    return {
      memory_aware_enabled: true,
      min_free_memory_mb: 256,
      max_memory_usage_ratio: 0.8,
      concurrent_syncs: 4,
    } as const;
  }
}

export async function waitForMemory(minFreeMB?: number, timeoutMs = 300_000): Promise<boolean> {
  const settings = getSettingsSafe();
  if (!settings.memory_aware_enabled) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { ok } = hasEnoughMemory(minFreeMB);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}
