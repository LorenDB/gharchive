import { NextRequest, NextResponse } from 'next/server';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { isAdmin } from '@/lib/auth';
import {
  cancelCompressMigrate,
  getCompressMigrateStatus,
  startCompressMigrate,
} from '@/lib/asset-compression-migrate';

/** Current migration job status (admin only). */
export async function GET() {
  return withApiUser(async (user) => {
    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }
    return NextResponse.json({ job: getCompressMigrateStatus() });
  });
}

/**
 * Start (or cancel) compression migration for all on-disk release assets.
 *
 * Body:
 * - { compress_release_assets?: boolean } — target policy (also saved to settings)
 * - { cancel: true } — request cancel of a running job
 */
export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async (user) => {
    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    try {
      const body = await req.json().catch(() => ({}));

      if (body?.cancel === true) {
        return NextResponse.json({ job: cancelCompressMigrate() });
      }

      const opts: { compress_release_assets?: boolean } = {};
      if (typeof body?.compress_release_assets === 'boolean') {
        opts.compress_release_assets = body.compress_release_assets;
      }

      const job = startCompressMigrate(opts);
      return NextResponse.json({ ok: true, job });
    } catch (err: any) {
      const status = /already running/i.test(err?.message || '') ? 409 : 400;
      return NextResponse.json(
        { error: err?.message || 'Failed to start migration', job: getCompressMigrateStatus() },
        { status }
      );
    }
  });
}
