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
  startScheduler,
} from '@/lib/scheduler';

const INTERVAL_OPTIONS = [1, 6, 12, 24, 48, 168] as const;

// Fallback if instrumentation didn't run (e.g. some deploy setups)
startScheduler();

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
      const n = Number(body.sync_interval_hours);
      if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
        return NextResponse.json(
          { error: 'sync_interval_hours must be between 1 and 720' },
          { status: 400 }
        );
      }
      patch.sync_interval_hours = Math.round(n);
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

    const settings = updateSettings(patch);
    return NextResponse.json({
      settings,
      scheduler: getSchedulerStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

/** Trigger an immediate scheduled pass (all due repos, or all if force). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const force = Boolean(body?.force);
    const result = await runScheduledSync(force);
    return NextResponse.json({
      ...result,
      scheduler: getSchedulerStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
