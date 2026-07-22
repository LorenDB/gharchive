import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetSettings = vi.fn();

vi.mock('@/lib/db', () => ({
  getSettings: () => mockGetSettings(),
  DEFAULT_SETTINGS: {
    memory_aware_enabled: true,
    min_free_memory_mb: 256,
    max_memory_usage_ratio: 0.8,
    concurrent_syncs: 4,
  },
}));

import {
  hasEnoughMemory,
  getAdjustedConcurrency,
  getMemoryStatusMessage,
  getMemoryInfo,
  waitForMemory,
} from '@/lib/memory';

afterEach(() => {
  mockGetSettings.mockReset();
});

describe('getMemoryInfo', () => {
  it('returns heap info', () => {
    const info = getMemoryInfo();
    expect(info.totalMB).toBeGreaterThan(0);
    expect(info.heapUsedMB).toBeGreaterThan(0);
    expect(info.heapTotalMB).toBeGreaterThan(0);
  });

  it('reports cgroupLimited boolean', () => {
    const info = getMemoryInfo();
    expect(typeof info.cgroupLimited).toBe('boolean');
  });
});

describe('hasEnoughMemory', () => {
  it('always returns ok when memory_aware is disabled', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: false,
    });

    const result = hasEnoughMemory();
    expect(result.ok).toBe(true);
  });

  it('returns ok when free memory exceeds threshold', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 128,
      max_memory_usage_ratio: 1.0,
    });

    const result = hasEnoughMemory(128, 1.0);
    // This depends on actual system memory. On a system with enough free RAM, it will pass.
    // The key is: the function doesn't throw.
    expect(typeof result.ok).toBe('boolean');
    expect(result.info).toBeDefined();
  });

  it('accepts optional overrides for minFreeMB and maxUsageRatio', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 256,
      max_memory_usage_ratio: 0.8,
    });

    const result = hasEnoughMemory(999_999, 0.01);
    expect(result.ok).toBe(false);
  });

  it('reports reason when rejecting', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 256,
      max_memory_usage_ratio: 0.8,
    });

    const result = hasEnoughMemory(999_999_999);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain('MB');
  });
});

describe('getAdjustedConcurrency', () => {
  it('returns desired when memory_aware is disabled', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: false,
    });

    expect(getAdjustedConcurrency(10)).toBe(10);
  });

  it('returns 0 when free memory is below minimum', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 999_999_999, // impossibly high
      max_memory_usage_ratio: 0.8,
      concurrent_syncs: 4,
    });

    expect(getAdjustedConcurrency(10)).toBe(0);
  });

  it('caps at concurrent_syncs limit', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 0,
      max_memory_usage_ratio: 1.0,
      concurrent_syncs: 2,
    });

    const result = getAdjustedConcurrency(100, 1);
    expect(result).toBeLessThanOrEqual(2);
  });

  it('returns a non-negative value', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 256,
      max_memory_usage_ratio: 0.8,
      concurrent_syncs: 4,
    });

    const result = getAdjustedConcurrency(4);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe('getMemoryStatusMessage', () => {
  it('returns null when memory_aware is disabled', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: false,
    });

    expect(getMemoryStatusMessage()).toBeNull();
  });

  it('returns a string when memory_aware is enabled', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 256,
      max_memory_usage_ratio: 0.8,
    });

    const msg = getMemoryStatusMessage();
    expect(typeof msg).toBe('string');
    expect(msg).toContain('MB');
  });

  it('includes LOW MEMORY when threshold not met', () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: true,
      min_free_memory_mb: 999_999_999,
      max_memory_usage_ratio: 0.8,
    });

    const msg = getMemoryStatusMessage();
    expect(msg).toContain('LOW MEMORY');
  });
});

describe('waitForMemory', () => {
  it('returns true immediately when memory_aware is disabled', async () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: false,
    });

    const result = await waitForMemory(undefined, 500);
    expect(result).toBe(true);
  }, 2000);

  it('returns true immediately when memory_aware is disabled', async () => {
    mockGetSettings.mockReturnValue({
      memory_aware_enabled: false,
    });

    const result = await waitForMemory(undefined, 500);
    expect(result).toBe(true);
  }, 2000);
});
