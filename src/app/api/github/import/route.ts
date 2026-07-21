import { NextRequest, NextResponse } from 'next/server';
import { fetchStarsPreview } from '@/lib/github';
import {
  startStarImport,
  getImportStatus,
  itemsFromSelection,
  requireGithubToken,
  scanAndMaybeImportStars,
} from '@/lib/import-stars';
import { ensureApiAuth } from '@/lib/api-auth';

export async function GET() {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  return NextResponse.json({ job: getImportStatus() });
}

/**
 * Start importing selected starred repos, or run a scheduled-style scan.
 * Body:
 * - { scan: true, force_import?: boolean } — scan all stars; import if force_import or setting
 * - { full_names: string[], list_ids?: string[] } — manual selection
 */
export async function POST(req: NextRequest) {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));

    if (body.scan) {
      const result = await scanAndMaybeImportStars({
        forceImport: Boolean(body.force_import ?? true),
      });
      return NextResponse.json({ ok: true, result, job: getImportStatus() });
    }

    if (getImportStatus().running) {
      return NextResponse.json(
        { error: 'An import is already running', job: getImportStatus() },
        { status: 409 }
      );
    }

    let fullNames: string[] = Array.isArray(body.full_names)
      ? body.full_names
      : [];

    const token = requireGithubToken();
    const preview = await fetchStarsPreview(token);

    if (Array.isArray(body.list_ids) && body.list_ids.length > 0) {
      const fromLists = new Set<string>();
      for (const list of preview.lists) {
        if (body.list_ids.includes(list.id)) {
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
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
