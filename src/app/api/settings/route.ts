import { NextRequest, NextResponse } from 'next/server';
import {
  getSettings,
  getEffectiveGlobalMaxAssetSize,
  updateSettings,
  pruneUserArchives,
  DEFAULT_SETTINGS,
  isReleaseAssetMode,
  type Settings,
  type ReleaseAssetMode,
} from '@/lib/db';
import { isUnsafeOutboundHostname } from '@/lib/safe-url';
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
    // Apprise URLs are scheme://... — allow anything with :// except
    // dangerous local schemes (these URLs are POSTed to the Apprise server,
    // which would interpret file:// / localhost targets).
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
      return {
        error: 'apprise_urls: invalid URL (expected scheme://…)',
      };
    }
    const scheme = u.split('://')[0]!.toLowerCase();
    if (['file', 'gopher', 'dict', 'ldap', 'ftp'].includes(scheme)) {
      return { error: `apprise_urls: scheme not allowed: ${scheme}` };
    }
  }
  return urls;
}

function rejectAdminOnly(field: string) {
  return { error: `${field} requires admin access` };
}

function checkOutboundHttpUrl(u: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return 'must be a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'must start with http:// or https://';
  }
  if (parsed.username || parsed.password) return 'must not contain credentials';
  if (isUnsafeOutboundHostname(parsed.hostname)) {
    return 'host not allowed (loopback / metadata)';
  }
  return null;
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
      users: data.users,
      storage: data.storage,
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

      if (body.release_asset_mode !== undefined) {
        if (!isReleaseAssetMode(body.release_asset_mode)) {
          return NextResponse.json(
            { error: 'release_asset_mode must be all, none, or last_n' },
            { status: 400 }
          );
        }
        patch.release_asset_mode = body.release_asset_mode as ReleaseAssetMode;
        patch.download_release_assets = body.release_asset_mode !== 'none';
      } else if (typeof body.download_release_assets === 'boolean') {
        // Legacy: boolean maps to all/none (does not force last_n off if already set)
        patch.download_release_assets = body.download_release_assets;
        if (body.download_release_assets === false) {
          patch.release_asset_mode = 'none';
        } else if (getSettings().release_asset_mode === 'none') {
          patch.release_asset_mode = 'all';
        }
      }

      if (body.release_asset_keep_last !== undefined) {
        const n = Number(body.release_asset_keep_last);
        if (!Number.isFinite(n) || n < 1 || n > 10_000) {
          return NextResponse.json(
            { error: 'release_asset_keep_last must be between 1 and 10000' },
            { status: 400 }
          );
        }
        patch.release_asset_keep_last = Math.round(n);
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
        // Enforce the effective global cap (admin-set, across all users),
        // not just the caller's own copy.
        const cap = getEffectiveGlobalMaxAssetSize();
        if (cap > 0 && val > cap) val = cap;
        patch.max_asset_size_mb = val;
      }

      if (body.concurrent_syncs !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('concurrent_syncs'), { status: 403 });
        const n = Number(body.concurrent_syncs);
        if (!Number.isFinite(n) || n < 1 || n > 8) {
          return NextResponse.json(
            { error: 'concurrent_syncs must be between 1 and 8' },
            { status: 400 }
          );
        }
        patch.concurrent_syncs = Math.round(n);
      }

      if (body.global_max_asset_size_mb !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('global_max_asset_size_mb'), { status: 403 });
        const n = Number(body.global_max_asset_size_mb);
        if (!Number.isFinite(n) || n < 0 || n > 100_000) {
          return NextResponse.json(
            { error: 'global_max_asset_size_mb must be between 0 and 100000' },
            { status: 400 }
          );
        }
        patch.global_max_asset_size_mb = Math.round(n);
      }

      // Storage compression for release assets (admin only)
      if (typeof body.compress_release_assets === 'boolean') {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('compress_release_assets'), { status: 403 });
        patch.compress_release_assets = body.compress_release_assets;
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
        if (body.auto_import_stars_list_ids.length > 100) {
          return NextResponse.json(
            { error: 'auto_import_stars_list_ids: at most 100 ids' },
            { status: 400 }
          );
        }
        patch.auto_import_stars_list_ids = body.auto_import_stars_list_ids
          .map((v: unknown) => String(v).slice(0, 128))
          .map((s: string) => s.trim())
          .filter(Boolean)
          .slice(0, 100);
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
      if (typeof body.memory_aware_enabled === 'boolean') {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('memory_aware_enabled'), { status: 403 });
        patch.memory_aware_enabled = body.memory_aware_enabled;
      }

      if (body.min_free_memory_mb !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('min_free_memory_mb'), { status: 403 });
        const n = Number(body.min_free_memory_mb);
        if (!Number.isFinite(n) || n < 64 || n > 65536) {
          return NextResponse.json(
            { error: 'min_free_memory_mb must be between 64 and 65536' },
            { status: 400 }
          );
        }
        patch.min_free_memory_mb = Math.round(n);
      }

      if (body.max_memory_usage_ratio !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('max_memory_usage_ratio'), { status: 403 });
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
          // System event alerts are admin-only; reject for non-admins (auditable)
          if ((key === 'alert_storage_low' || key === 'alert_memory_low') && !userIsAdmin) {
            return NextResponse.json(rejectAdminOnly(key), { status: 403 });
          }
          patch[key] = body[key];
        }
      }

      // apprise_api_url is admin-only: it controls where the server POSTs
      // (SSRF surface). Non-admins use APPRISE_API_URL env or admin-set base.
      if (body.apprise_api_url !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('apprise_api_url'), { status: 403 });
        if (typeof body.apprise_api_url !== 'string') {
          return NextResponse.json(
            { error: 'apprise_api_url must be a string' },
            { status: 400 }
          );
        }
        const u = body.apprise_api_url.trim();
        if (u) {
          if (!/^https?:\/\//i.test(u)) {
            return NextResponse.json(
              { error: 'apprise_api_url must start with http:// or https://' },
              { status: 400 }
            );
          }
          const outboundErr = checkOutboundHttpUrl(u);
          if (outboundErr) {
            return NextResponse.json(
              { error: `apprise_api_url ${outboundErr}` },
              { status: 400 }
            );
          }
        }
        if (u.length > 500) {
          return NextResponse.json(
            { error: 'apprise_api_url too long' },
            { status: 400 }
          );
        }
        patch.apprise_api_url = u;
      }

      // apprise_endpoint_url is admin-only: overrides the default /notify path
      // construction and POSTs directly to this URL (SSRF surface).
      if (body.apprise_endpoint_url !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('apprise_endpoint_url'), { status: 403 });
        if (typeof body.apprise_endpoint_url !== 'string') {
          return NextResponse.json(
            { error: 'apprise_endpoint_url must be a string' },
            { status: 400 }
          );
        }
        const u = body.apprise_endpoint_url.trim();
        if (u) {
          if (!/^https?:\/\//i.test(u)) {
            return NextResponse.json(
              { error: 'apprise_endpoint_url must start with http:// or https://' },
              { status: 400 }
            );
          }
          const outboundErr = checkOutboundHttpUrl(u);
          if (outboundErr) {
            return NextResponse.json(
              { error: `apprise_endpoint_url ${outboundErr}` },
              { status: 400 }
            );
          }
        }
        if (u.length > 500) {
          return NextResponse.json(
            { error: 'apprise_endpoint_url too long' },
            { status: 400 }
          );
        }
        patch.apprise_endpoint_url = u;
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

      if (body.storage_alert_threshold_percent !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('storage_alert_threshold_percent'), { status: 403 });
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

      if (body.storage_alert_min_free_mb !== undefined) {
        if (!userIsAdmin)
          return NextResponse.json(rejectAdminOnly('storage_alert_min_free_mb'), { status: 403 });
        const n = Number(body.storage_alert_min_free_mb);
        if (!Number.isFinite(n) || n < 0 || n > 1024 * 1024) {
          return NextResponse.json(
            { error: 'storage_alert_min_free_mb must be between 0 and 1048576' },
            { status: 400 }
          );
        }
        patch.storage_alert_min_free_mb = Math.round(n);
      }

      // Wayback Machine — README absolute URL archival (per-user).
      // Secrets use placeholder-update: empty string = keep existing,
      // "__CLEAR__" = clear, non-empty = replace. GET never returns raw values.
      if (typeof body.wayback_readme_urls_enabled === 'boolean') {
        patch.wayback_readme_urls_enabled = body.wayback_readme_urls_enabled;
      }

      if (body.wayback_access_key !== undefined) {
        if (typeof body.wayback_access_key !== 'string') {
          return NextResponse.json(
            { error: 'wayback_access_key must be a string' },
            { status: 400 }
          );
        }
        const k = body.wayback_access_key.trim();
        if (k === '' || k === '__CLEAR__') {
          if (k === '__CLEAR__') patch.wayback_access_key = '';
          // empty = keep existing (do not overwrite with blank)
        } else {
          if (k.length > 256) {
            return NextResponse.json(
              { error: 'wayback_access_key too long' },
              { status: 400 }
            );
          }
          // Allow alphanumeric + common S3 key chars
          if (!/^[A-Za-z0-9_-]+$/.test(k)) {
            return NextResponse.json(
              {
                error:
                  'wayback_access_key must be alphanumeric (plus _ -)',
              },
              { status: 400 }
            );
          }
          patch.wayback_access_key = k;
        }
      }

      if (body.wayback_secret_key !== undefined) {
        if (typeof body.wayback_secret_key !== 'string') {
          return NextResponse.json(
            { error: 'wayback_secret_key must be a string' },
            { status: 400 }
          );
        }
        const k = body.wayback_secret_key.trim();
        if (k === '' || k === '__CLEAR__') {
          if (k === '__CLEAR__') patch.wayback_secret_key = '';
        } else {
          if (k.length > 256) {
            return NextResponse.json(
              { error: 'wayback_secret_key too long' },
              { status: 400 }
            );
          }
          if (!/^[A-Za-z0-9_-]+$/.test(k)) {
            return NextResponse.json(
              {
                error:
                  'wayback_secret_key must be alphanumeric (plus _ -)',
              },
              { status: 400 }
            );
          }
          patch.wayback_secret_key = k;
        }
      }

      const settings = updateSettings(patch);
      // Global retention tightening affects every repo inheriting the
      // default — flush assets outside the new effective policy now
      // instead of waiting for the next sync.
      let pruned_assets = 0;
      if (
        patch.release_asset_mode !== undefined ||
        patch.release_asset_keep_last !== undefined ||
        patch.download_release_assets !== undefined
      ) {
        pruned_assets = pruneUserArchives(user.id);
      }
      return NextResponse.json({
        settings,
        pruned_assets,
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
