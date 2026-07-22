import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetSettings = vi.fn();
const mockTryGetUserId = vi.fn();

vi.mock('@/lib/db', () => ({
  getSettings: () => mockGetSettings(),
}));

vi.mock('@/lib/user-context', () => ({
  tryGetUserId: () => mockTryGetUserId(),
}));

import {
  isAlertsConfigured,
  repoLabel,
  ALERT_CATEGORIES,
  ALERT_CATEGORY_META,
} from '@/lib/alerts';

afterEach(() => {
  mockGetSettings.mockReset();
  mockTryGetUserId.mockReset();
});

describe('ALERT_CATEGORIES', () => {
  it('has all expected categories', () => {
    expect(ALERT_CATEGORIES).toContain('new_release');
    expect(ALERT_CATEGORIES).toContain('releases_wiped');
    expect(ALERT_CATEGORIES).toContain('history_wiped');
    expect(ALERT_CATEGORIES).toContain('repo_deleted');
    expect(ALERT_CATEGORIES).toContain('repo_archived');
    expect(ALERT_CATEGORIES).toContain('sync_failed');
    expect(ALERT_CATEGORIES).toContain('storage_low');
    expect(ALERT_CATEGORIES).toContain('memory_low');
    expect(ALERT_CATEGORIES.length).toBe(8);
  });
});

describe('ALERT_CATEGORY_META', () => {
  it('has metadata for every category', () => {
    for (const cat of ALERT_CATEGORIES) {
      expect(ALERT_CATEGORY_META[cat]).toBeDefined();
      expect(ALERT_CATEGORY_META[cat].label).toBeTruthy();
      expect(ALERT_CATEGORY_META[cat].description).toBeTruthy();
      expect(ALERT_CATEGORY_META[cat].severity).toMatch(/^(info|success|warning|failure)$/);
      expect(ALERT_CATEGORY_META[cat].settingKey).toBeTruthy();
    }
  });

  it('new_release has info severity', () => {
    expect(ALERT_CATEGORY_META.new_release.severity).toBe('info');
  });

  it('repo_deleted has failure severity', () => {
    expect(ALERT_CATEGORY_META.repo_deleted.severity).toBe('failure');
  });
});

describe('isAlertsConfigured', () => {
  it('returns false when alerts_enabled is false', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: false,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: '',
      apprise_urls: ['discord://webhook'],
    });
    expect(isAlertsConfigured()).toBe(false);
  });

  it('returns false when apprise_api_url is empty', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: '',
      apprise_config_key: '',
      apprise_urls: ['discord://webhook'],
    });
    expect(isAlertsConfigured()).toBe(false);
  });

  it('returns true when config_key is set', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: 'my-key',
      apprise_urls: [],
    });
    expect(isAlertsConfigured()).toBe(true);
  });

  it('returns true when apprise_urls has entries (stateless)', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: '',
      apprise_urls: ['discord://webhook'],
    });
    expect(isAlertsConfigured()).toBe(true);
  });

  it('returns false when no URLs and no config key', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: '',
      apprise_urls: [],
    });
    expect(isAlertsConfigured()).toBe(false);
  });

  it('filters empty string URLs', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: '',
      apprise_urls: ['', '   '],
    });
    expect(isAlertsConfigured()).toBe(false);
  });

  it('accepts optional settings parameter', () => {
    const result = isAlertsConfigured({
      alerts_enabled: true,
      apprise_api_url: 'http://apprise:8000',
      apprise_config_key: 'k',
      apprise_urls: [],
    } as ReturnType<typeof mockGetSettings>);
    expect(result).toBe(true);
  });

  it('returns true when apprise_endpoint_url is set (no base URL needed)', () => {
    mockGetSettings.mockReturnValue({
      alerts_enabled: true,
      apprise_api_url: '',
      apprise_endpoint_url: 'https://notify.example.com/webhook',
      apprise_config_key: '',
      apprise_urls: [],
    });
    expect(isAlertsConfigured()).toBe(true);
  });
});

describe('repoLabel', () => {
  it('formats a repo label', () => {
    expect(
      repoLabel({ platform: 'github', owner: 'acme', name: 'myrepo' })
    ).toBe('github:acme/myrepo');
  });

  it('formats gitlab repos', () => {
    expect(
      repoLabel({ platform: 'gitlab', owner: 'group', name: 'project' })
    ).toBe('gitlab:group/project');
  });
});
