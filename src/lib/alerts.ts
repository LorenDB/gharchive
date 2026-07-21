import { getSettings, type Settings } from '@/lib/db';
import { tryGetUserId } from '@/lib/user-context';

/**
 * Granular alert categories. Each maps 1:1 to an Apprise tag (when
 * `apprise_use_tags` is on) so destinations can be routed per category.
 */
export const ALERT_CATEGORIES = [
  'new_release',
  'releases_wiped',
  'history_wiped',
  'repo_deleted',
  'repo_archived',
  'sync_failed',
  'storage_low',
  'memory_low',
] as const;

export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const ALERT_CATEGORY_META: Record<
  AlertCategory,
  { label: string; description: string; severity: AlertSeverity; settingKey: AlertSettingKey }
> = {
  new_release: {
    label: 'New release',
    description: 'A new release tag was published and archived.',
    severity: 'info',
    settingKey: 'alert_new_release',
  },
  releases_wiped: {
    label: 'Releases wiped',
    description: 'Remote releases disappeared (archive had some; upstream now has none).',
    severity: 'failure',
    settingKey: 'alert_releases_wiped',
  },
  history_wiped: {
    label: 'History wiped',
    description: 'Git history was force-rewritten or branches/tags mass-deleted upstream.',
    severity: 'failure',
    settingKey: 'alert_history_wiped',
  },
  repo_deleted: {
    label: 'Repo deleted',
    description: 'The remote repository is gone or inaccessible (404 / not found).',
    severity: 'failure',
    settingKey: 'alert_repo_deleted',
  },
  repo_archived: {
    label: 'Repo archived',
    description: 'The remote repository was marked as archived on GitHub/GitLab.',
    severity: 'warning',
    settingKey: 'alert_repo_archived',
  },
  sync_failed: {
    label: 'Sync failed',
    description: 'A repository sync failed for a non-deletion reason.',
    severity: 'warning',
    settingKey: 'alert_sync_failed',
  },
  storage_low: {
    label: 'Storage low',
    description: 'DATA_DIR disk usage is high or free space is below the threshold.',
    severity: 'warning',
    settingKey: 'alert_storage_low',
  },
  memory_low: {
    label: 'Memory low',
    description: 'System or cgroup memory is critically low; jobs may be deferred.',
    severity: 'warning',
    settingKey: 'alert_memory_low',
  },
};

type AlertSettingKey =
  | 'alert_new_release'
  | 'alert_releases_wiped'
  | 'alert_history_wiped'
  | 'alert_repo_deleted'
  | 'alert_repo_archived'
  | 'alert_sync_failed'
  | 'alert_storage_low'
  | 'alert_memory_low';

export type AlertSeverity = 'info' | 'success' | 'warning' | 'failure';

export interface AlertPayload {
  category: AlertCategory;
  title: string;
  body: string;
  /** Dedup key suffix (e.g. repo full name + tag). Same key won't re-fire within cooldown. */
  subject?: string;
  severity?: AlertSeverity;
  /** Override default cooldown (ms). */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS: Record<AlertCategory, number> = {
  new_release: 0, // each release is unique via subject
  releases_wiped: 6 * 3600_000,
  history_wiped: 6 * 3600_000,
  repo_deleted: 24 * 3600_000,
  repo_archived: 24 * 3600_000,
  sync_failed: 2 * 3600_000,
  storage_low: 6 * 3600_000,
  memory_low: 2 * 3600_000,
};

/** In-process dedup so we don't spam the same alert every scheduler tick. */
const g = globalThis as typeof globalThis & {
  __gharchiveAlertCooldowns?: Map<string, number>;
};

function cooldowns(): Map<string, number> {
  if (!g.__gharchiveAlertCooldowns) {
    g.__gharchiveAlertCooldowns = new Map();
  }
  return g.__gharchiveAlertCooldowns;
}

function categoryEnabled(settings: Settings, category: AlertCategory): boolean {
  const key = ALERT_CATEGORY_META[category].settingKey;
  return Boolean(settings[key]);
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function isAlertsConfigured(settings?: Settings): boolean {
  const s = settings ?? getSettings();
  if (!s.alerts_enabled) return false;
  const api = s.apprise_api_url?.trim();
  if (!api) return false;
  if (s.apprise_config_key?.trim()) return true;
  return Array.isArray(s.apprise_urls) && s.apprise_urls.some((u) => u.trim());
}

/**
 * Send an alert via Apprise API when the category is enabled and configured.
 * Never throws — failures are logged so sync/scheduler keep running.
 */
export async function sendAlert(
  payload: AlertPayload
): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  try {
    const settings = getSettings();
    if (!settings.alerts_enabled) {
      return { sent: false, skipped: 'alerts disabled' };
    }
    if (!categoryEnabled(settings, payload.category)) {
      return { sent: false, skipped: `category ${payload.category} disabled` };
    }
    if (!isAlertsConfigured(settings)) {
      return { sent: false, skipped: 'Apprise not configured' };
    }

    const userId = tryGetUserId() ?? 'system';
    const subject = payload.subject ?? 'default';
    const cooldownKey = `${userId}:${payload.category}:${subject}`;
    const cooldownMs =
      payload.cooldownMs ?? DEFAULT_COOLDOWN_MS[payload.category] ?? 3600_000;
    const now = Date.now();
    const last = cooldowns().get(cooldownKey) ?? 0;
    if (cooldownMs > 0 && now - last < cooldownMs) {
      return { sent: false, skipped: 'cooldown' };
    }

    const severity =
      payload.severity ?? ALERT_CATEGORY_META[payload.category].severity;
    const result = await postToApprise(settings, {
      title: payload.title,
      body: payload.body,
      type: severity,
      tag: settings.apprise_use_tags ? payload.category : undefined,
    });

    if (result.ok) {
      cooldowns().set(cooldownKey, now);
      return { sent: true };
    }
    return { sent: false, error: result.error };
  } catch (err: any) {
    console.error('[alerts] send failed:', err?.message || err);
    return { sent: false, error: err?.message || String(err) };
  }
}

/**
 * Fire a test notification (bypasses category toggles and cooldown).
 * Still requires alerts_enabled + Apprise config.
 */
export async function sendTestAlert(
  category: AlertCategory = 'new_release'
): Promise<{ ok: boolean; error?: string }> {
  const settings = getSettings();
  if (!settings.alerts_enabled) {
    return { ok: false, error: 'Alerts are disabled' };
  }
  if (!isAlertsConfigured(settings)) {
    return {
      ok: false,
      error:
        'Configure an Apprise API URL and either a config key or at least one Apprise URL',
    };
  }

  const meta = ALERT_CATEGORY_META[category];
  const result = await postToApprise(settings, {
    title: `[GHArchive test] ${meta.label}`,
    body: `Test notification for category \`${category}\`.\n\n${meta.description}\n\nIf you received this, Apprise is wired correctly.`,
    type: 'info',
    tag: settings.apprise_use_tags ? category : undefined,
  });

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

interface AppriseNotifyBody {
  title: string;
  body: string;
  type: AlertSeverity;
  tag?: string;
}

async function postToApprise(
  settings: Settings,
  msg: AppriseNotifyBody
): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeApiUrl(settings.apprise_api_url.trim());
  const key = settings.apprise_config_key?.trim();
  const urls = (settings.apprise_urls || []).map((u) => u.trim()).filter(Boolean);

  const path = key ? `/notify/${encodeURIComponent(key)}` : '/notify';
  const url = `${base}${path}`;

  const payload: Record<string, unknown> = {
    title: msg.title,
    body: msg.body,
    type: msg.type,
    format: 'markdown',
  };

  if (!key) {
    if (urls.length === 0) {
      return { ok: false, error: 'No Apprise URLs configured for stateless notify' };
    }
    payload.urls = urls.join(',');
  }

  if (msg.tag) {
    payload.tag = msg.tag;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // Apprise returns 200 on success, 424 if some destinations failed, 204 empty config
    if (res.ok || res.status === 424) {
      if (res.status === 424) {
        console.warn(
          `[alerts] Apprise partial failure (${res.status}) for ${msg.title}`
        );
      }
      return { ok: true };
    }

    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Apprise HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'Apprise request timed out' };
    }
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Helper to format a repo identity for alert bodies. */
export function repoLabel(repo: {
  platform: string;
  owner: string;
  name: string;
}): string {
  return `${repo.platform}:${repo.owner}/${repo.name}`;
}
