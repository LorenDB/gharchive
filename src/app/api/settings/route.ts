import { NextRequest, NextResponse } from 'next/server';
import {
  getSettings,
  updateSettings,
  DEFAULT_SETTINGS,
  type Settings,
} from '@/lib/db';
import {
  getSchedulerStatus,
  runScheduledSync,
  runScheduledGithubScan,
  startScheduler,
} from '@/lib/scheduler';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { getRequiredUserId } from '@/lib/user-context';
import { isAdmin } from '@/lib/auth';
import {
  ALERT_CATEGORIES,
  ALERT_CATEGORY_META,
  isAlertsConfigured,
  type AlertCategory,
} from '@/lib/alerts';

const INTERVAL_OPTIONS = [1, 6, 12, 24, 48, 168] as const;

const ALERT_BOOL_KEYS = [
  'alerts_enabled',
  'apprise_use_tags',
  'alert_new_release',
  'alert_releases_wiped',
  'alert_history_wiped',
  'alert_repo_deleted',
  'alert_repo_archived',
  'alert_sync_failed',
  'alert_storage_low',
  'alert_memory_low',
] as const;

startScheduler();

function parseHours(
  value: unknown,
  field: string
): number | { error: string } {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
    return { error: `${field} must be between 1 and 720` };
  }
  return Math.round(n);
}

function parseAppriseUrls(value: unknown): string[] | { error: string } {
  if (value === undefined || value === null) return [];
  let lines: string[] = [];
  if (typeof value === 'string') {
    lines = value.split(/[\n,]+/);
  } else if (Array.isArray(value)) {
    lines = value.map((v) => String(v));
  } else {
    return { error: 'apprise_urls must be a string or array' };
  }
  const urls = lines.map((u) => u.trim()).filter(Boolean);
  if (urls.length > 50) {
    return { error: 'apprise_urls: at most 50 URLs' };
  }
  for (const u of urls) {
    if (u.length > 2000) {
      return { error: 'apprise_urls: URL too long' };
    }
    // Apprise URLs are scheme://... — allow anything with ://
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
      return {
        error: `apprise_urls: invalid URL (expected scheme://…): ${u.slice(0, 60)}`,
      };
    }
  }
  return urls;
}

export async function GET() {
  return withApiUser(async (user) => {
    const { getSettingsPageData } = await import('@/lib/server-data');
    const data = await getSettingsPageData(user);
    return NextResponse.json({
      settings: data.settings,
      defaults: data.defaults,
      interval_options: data.interval_options,
      scheduler: data.scheduler,
      alerts: data.alerts,
      disk: data.disk,
      is_admin: data.is_admin,
    });
  });
}

export async function PUT(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 60, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async (user) => {
    try {
      const body = await req.json();
      const patch: Partial<Settings> = {};
      const userIsAdmin = isAdmin(user);

      if (typeof body.auto_sync_enabled === 'boolean') {
        patch.auto_sync_enabled = body.auto_sync_enabled;
      }

      if (body.sync_interval_hours !== undefined) {
        const n = parseHours(body.sync_interval_hours, 'sync_interval_hours');
        if (typeof n === 'object') {
          return NextResponse.json(n, { status: 400 });
        }
        patch.sync_interval_hours = n;
      }

      if (typeof body.download_release_assets === 'boolean') {
        patch.download_release_assets = body.download_release_assets;
      }

      if (body.max_asset_size_mb !== undefined) {
        const n = Number(body.max_asset_size_mb);
        if (!Number.isFinite(n) || n < 0 || n > 100_000) {
          return NextResponse.json(
            { error: 'max_asset_size_mb must be between 0 and 100000' },
            { status: 400 }
          );
        }
        let val = Math.round(n);
        const settings = getSettings();
        if (settings.global_max_asset_size_mb > 0 && val > settings.global_max_asset_size_mb) {
          val = settings.global_max_asset_size_mb;
        }
        patch.max_asset_size_mb = val;
      }

      if (body.concurrent_syncs !== undefined && userIsAdmin) {
        const n = Number(body.concurrent_syncs);
        if (!Number.isFinite(n) || n < 1 || n > 8) {
          return NextResponse.json(
            { error: 'concurrent_syncs must be between 1 and 8' },
            { status: 400 }
          );
        }
        patch.concurrent_syncs = Math.round(n);
      }

      if (body.global_max_asset_size_mb !== undefined && userIsAdmin) {
        const n = Number(body.global_max_asset_size_mb);
        if (!Number.isFinite(n) || n < 0 || n > 100_000) {
          return NextResponse.json(
            { error: 'global_max_asset_size_mb must be between 0 and 100000' },
            { status: 400 }
          );
        }
        patch.global_max_asset_size_mb = Math.round(n);
      }

      // GitHub scan / auto-import
      for (const key of [
        'auto_scan_stars_enabled',
        'auto_import_stars_enabled',
        'auto_scan_owned_enabled',
        'auto_import_owned_enabled',
        'auto_import_owned_include_forks',
        'auto_import_owned_include_private',
      ] as const) {
        if (typeof body[key] === 'boolean') {
          patch[key] = body[key];
        }
      }

      if (body.auto_import_stars_list_ids !== undefined) {
        if (!Array.isArray(body.auto_import_stars_list_ids)) {
          return NextResponse.json(
            { error: 'auto_import_stars_list_ids must be an array' },
            { status: 400 }
          );
        }
        patch.auto_import_stars_list_ids = body.auto_import_stars_list_ids
          .map(String)
          .filter(Boolean);
      }

      // Enabling auto-import implies scanning
      if (patch.auto_import_stars_enabled === true) {
        patch.auto_scan_stars_enabled = true;
      }
      if (patch.auto_import_owned_enabled === true) {
        patch.auto_scan_owned_enabled = true;
      }

      if (body.github_scan_interval_hours !== undefined) {
        const n = parseHours(
          body.github_scan_interval_hours,
          'github_scan_interval_hours'
        );
        if (typeof n === 'object') {
          return NextResponse.json(n, { status: 400 });
        }
        patch.github_scan_interval_hours = n;
      }

      // Memory-aware settings (admin only)
      if (typeof body.memory_aware_enabled === 'boolean' && userIsAdmin) {
        patch.memory_aware_enabled = body.memory_aware_enabled;
      }

      if (body.min_free_memory_mb !== undefined && userIsAdmin) {
        const n = Number(body.min_free_memory_mb);
        if (!Number.isFinite(n) || n < 64 || n > 65536) {
          return NextResponse.json(
            { error: 'min_free_memory_mb must be between 64 and 65536' },
            { status: 400 }
          );
        }
        patch.min_free_memory_mb = Math.round(n);
      }

      if (body.max_memory_usage_ratio !== undefined && userIsAdmin) {
        const n = Number(body.max_memory_usage_ratio);
        if (!Number.isFinite(n) || n < 0.1 || n > 1) {
          return NextResponse.json(
            { error: 'max_memory_usage_ratio must be between 0.1 and 1' },
            { status: 400 }
          );
        }
        patch.max_memory_usage_ratio = Math.round(n * 100) / 100;
      }

      // Alerts / Apprise
      // Archive event alert booleans are available to everyone
      for (const key of ALERT_BOOL_KEYS) {
        if (typeof body[key] === 'boolean') {
          // System event alerts are admin-only; silently skip for non-admins
          if ((key === 'alert_storage_low' || key === 'alert_memory_low') && !userIsAdmin) {
            continue;
          }
          patch[key] = body[key];
        }
      }

      // apprise_api_url is admin-only: it controls where the server POSTs
      // (SSRF surface). Non-admins use APPRISE_API_URL env or admin-set base.
      if (body.apprise_api_url !== undefined && userIsAdmin) {
        if (typeof body.apprise_api_url !== 'string') {
          return NextResponse.json(
            { error: 'apprise_api_url must be a string' },
            { status: 400 }
          );
        }
        const u = body.apprise_api_url.trim();
        if (u && !/^https?:\/\//i.test(u)) {
          return NextResponse.json(
            { error: 'apprise_api_url must start with http:// or https://' },
            { status: 400 }
          );
        }
        if (u.length > 500) {
          return NextResponse.json(
            { error: 'apprise_api_url too long' },
            { status: 400 }
          );
        }
        patch.apprise_api_url = u;
      }

      if (body.apprise_config_key !== undefined) {
        if (typeof body.apprise_config_key !== 'string') {
          return NextResponse.json(
            { error: 'apprise_config_key must be a string' },
            { status: 400 }
          );
        }
        const k = body.apprise_config_key.trim();
        if (k && !/^[a-zA-Z0-9_-]{1,128}$/.test(k)) {
          return NextResponse.json(
            {
              error:
                'apprise_config_key must be 1–128 alphanumeric characters (plus _ -)',
            },
            { status: 400 }
          );
        }
        patch.apprise_config_key = k;
      }

      if (body.apprise_urls !== undefined) {
        const urls = parseAppriseUrls(body.apprise_urls);
        if (!Array.isArray(urls)) {
          return NextResponse.json(urls, { status: 400 });
        }
        patch.apprise_urls = urls;
      }

      if (body.storage_alert_threshold_percent !== undefined && userIsAdmin) {
        const n = Number(body.storage_alert_threshold_percent);
        if (!Number.isFinite(n) || n < 50 || n > 100) {
          return NextResponse.json(
            {
              error:
                'storage_alert_threshold_percent must be between 50 and 100',
            },
            { status: 400 }
          );
        }
        patch.storage_alert_threshold_percent = Math.round(n);
      }

      if (body.storage_alert_min_free_mb !== undefined && userIsAdmin) {
        const n = Number(body.storage_alert_min_free_mb);
        if (!Number.isFinite(n) || n < 0 || n > 1024 * 1024) {
          return NextResponse.json(
            { error: 'storage_alert_min_free_mb must be between 0 and 1048576' },
            { status: 400 }
          );
        }
        patch.storage_alert_min_free_mb = Math.round(n);
      }

      const settings = updateSettings(patch);
      return NextResponse.json({
        settings,
        scheduler: getSchedulerStatus(),
        alerts: {
          configured: isAlertsConfigured(settings),
          categories: ALERT_CATEGORIES.map((id) => ({
            id,
            ...ALERT_CATEGORY_META[id as AlertCategory],
          })),
        },
        is_admin: userIsAdmin,
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}

/**
 * Trigger work immediately.
 * Body: { force?: boolean, github_scan?: boolean, sync?: boolean }
 * Defaults: sync only (force). Set github_scan:true to run star/owned scan.
 */
export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const force = Boolean(body?.force);
      const doSync = body?.sync !== false;
      const doGithub = Boolean(body?.github_scan);

      const result: Record<string, unknown> = {};

      const userId = getRequiredUserId();
      if (doSync) {
        result.sync = await runScheduledSync(force, userId);
      }
      if (doGithub) {
        result.github = await runScheduledGithubScan(force, userId);
      }

      return NextResponse.json({
        ...result,
        scheduler: getSchedulerStatus(),
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  });
}
