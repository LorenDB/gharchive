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

const INTERVAL_OPTIONS = [1, 6, 12, 24, 48, 168] as const;

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

export async function GET() {
  return NextResponse.json({
    settings: getSettings(),
    defaults: DEFAULT_SETTINGS,
    interval_options: INTERVAL_OPTIONS,
    scheduler: getSchedulerStatus(),
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const patch: Partial<Settings> = {};

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
      patch.max_asset_size_mb = Math.round(n);
    }

    if (body.concurrent_syncs !== undefined) {
      const n = Number(body.concurrent_syncs);
      if (!Number.isFinite(n) || n < 1 || n > 8) {
        return NextResponse.json(
          { error: 'concurrent_syncs must be between 1 and 8' },
          { status: 400 }
        );
      }
      patch.concurrent_syncs = Math.round(n);
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

    const settings = updateSettings(patch);
    return NextResponse.json({
      settings,
      scheduler: getSchedulerStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

/**
 * Trigger work immediately.
 * Body: { force?: boolean, github_scan?: boolean, sync?: boolean }
 * Defaults: sync only (force). Set github_scan:true to run star/owned scan.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = Boolean(body?.force);
    const doSync = body?.sync !== false;
    const doGithub = Boolean(body?.github_scan);

    const result: Record<string, unknown> = {};

    if (doSync) {
      result.sync = await runScheduledSync(force);
    }
    if (doGithub) {
      result.github = await runScheduledGithubScan(force);
    }

    return NextResponse.json({
      ...result,
      scheduler: getSchedulerStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
