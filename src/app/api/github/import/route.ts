import { NextRequest, NextResponse } from 'next/server';
import { fetchStarsPreview } from '@/lib/github';
import {
  startStarImport,
  getImportStatus,
  getPendingItems,
  cancelImport,
  itemsFromSelection,
  requireGithubToken,
  scanAndMaybeImportStars,
} from '@/lib/import-stars';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { tryGetUserId } from '@/lib/user-context';

export async function GET() {
  return withApiUser(async () => {
    const job = getImportStatus();
    const userId = tryGetUserId();
    return NextResponse.json({
      job: {
        ...job,
        pending_items: getPendingItems(userId ?? undefined),
      },
    });
  });
}

/**
 * Start importing selected starred repos, or run a scheduled-style scan.
 * Body:
 * - { scan: true, force_import?: boolean } — scan all stars; import only if force_import is true
 * - { full_names: string[], list_ids?: string[] } — manual selection
 */
export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const raw = await req.text();
      if (raw.length > 1_000_000) {
        return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
      }
      const body = JSON.parse(raw);

      if (body.scan) {
        const forceImport = typeof body.force_import === 'boolean'
          ? body.force_import
          : false;
        const result = await scanAndMaybeImportStars({ forceImport });
        return NextResponse.json({ ok: true, result, job: getImportStatus() });
      }

      if (getImportStatus().running) {
        return NextResponse.json(
          { error: 'An import is already running', job: getImportStatus() },
          { status: 409 }
        );
      }

      let fullNames: string[] = Array.isArray(body.full_names)
        ? body.full_names.filter(
            (n: unknown): n is string => typeof n === 'string' && /^[\w.-]+\/[\w.-]+$/.test(n)
          )
        : [];

      const token = requireGithubToken();
      const preview = await fetchStarsPreview(token);

      if (Array.isArray(body.list_ids) && body.list_ids.length > 0) {
        const listIds: string[] = body.list_ids.filter(
          (id: unknown): id is string => typeof id === 'string'
        );
        const fromLists = new Set<string>();
        for (const list of preview.lists) {
          if (listIds.includes(list.id)) {
            for (const r of list.repos) fromLists.add(r);
          }
        }
        if (body.include_unlisted) {
          for (const u of preview.unlisted) fromLists.add(u);
        }
        if (fullNames.length === 0) {
          fullNames = [...fromLists];
        } else {
          fullNames = fullNames.filter((n) => fromLists.has(n));
        }
      }

      fullNames = [...new Set(fullNames.filter(Boolean))];
      if (fullNames.length === 0) {
        return NextResponse.json(
          { error: 'No repositories selected' },
          { status: 400 }
        );
      }

      const items = itemsFromSelection(
        preview.stars,
        fullNames,
        preview.membership
      );

      const job = startStarImport(
        items,
        preview.lists.map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
        })),
        'manual-stars'
      );

      return NextResponse.json({ ok: true, job, selected: items.length });
    } catch (err: any) {
      const message = err?.message || 'Internal error';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

export async function DELETE(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 10, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    const job = cancelImport();
    const userId = tryGetUserId();
    return NextResponse.json({
      ok: true,
      job: { ...job, pending_items: getPendingItems(userId ?? undefined) },
    });
  });
}
