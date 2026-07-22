import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatRelativeTime,
  formatDate,
  formatDateShort,
} from '@/lib/format';

describe('formatBytes', () => {
  it('returns em-dash for null/undefined', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('returns 0 B for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('formats GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('formats TB', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });
});

describe('formatRelativeTime', () => {
  it('returns just now for recent times', () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(recent)).toBe('just now');
  });

  it('returns minutes ago', () => {
    const past = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(past)).toBe('5m ago');
  });

  it('returns hours ago', () => {
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(past)).toBe('3h ago');
  });

  it('returns days ago', () => {
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(past)).toBe('2d ago');
  });

  it('returns locale date for older dates', () => {
    const past = new Date(Date.now() - 60 * 86400_000).toISOString();
    expect(formatRelativeTime(past)).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it('handles naive ISO by appending Z', () => {
    const past = new Date(Date.now() - 5000).toISOString().replace('Z', '');
    expect(formatRelativeTime(past)).toBe('just now');
  });

  it('handles ISO with offset', () => {
    const past = new Date(Date.now() - 5000).toISOString().replace('Z', '+00:00');
    expect(formatRelativeTime(past)).toBe('just now');
  });
});

describe('formatDate', () => {
  it('returns em-dash for null/undefined', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('returns a formatted date string', () => {
    const result = formatDate('2026-01-15T12:00:00Z');
    expect(result).toContain('2026');
    expect(result.length).toBeGreaterThan(5);
  });

  it('handles naive ISO by appending Z', () => {
    const result = formatDate('2026-01-15T12:00:00');
    expect(result).toContain('2026');
  });
});

describe('formatDateShort', () => {
  it('returns em-dash for null/undefined', () => {
    expect(formatDateShort(null)).toBe('—');
    expect(formatDateShort(undefined)).toBe('—');
  });

  it('returns a short date string', () => {
    const result = formatDateShort('2026-01-15T12:00:00Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('—');
  });
});
