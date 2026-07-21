import { NextRequest, NextResponse } from 'next/server';
import { findRepo, getGithubAccountPublic, getSettings } from '@/lib/db';
import { fetchOwnedRepos, validateGithubToken } from '@/lib/github';
import {
  requireGithubToken,
  itemsFromOwned,
  startStarImport,
  getImportStatus,
  scanAndMaybeImportOwned,
} from '@/lib/import-stars';

/** Preview owned repositories for the linked account. */
export async function GET() {
  try {
    const account = getGithubAccountPublic();
    if (!account) {
      return NextResponse.json(
        { error: 'Link a GitHub account in Settings first' },
        { status: 400 }
      );
    }

    const token = requireGithubToken();
    const settings = getSettings();
    const [user, owned] = await Promise.all([
      validateGithubToken(token),
      fetchOwnedRepos(token, {
        includeForks: settings.auto_import_owned_include_forks,
        includePrivate: settings.auto_import_owned_include_private,
      }),
    ]);

    const repos = owned.map((r) => {
      const existing = findRepo('github', r.owner, r.name);
      return {
        ...r,
        archived: Boolean(existing),
        archived_repo_id: existing?.id ?? null,
      };
    });

    return NextResponse.json({
      account,
      user,
      repos,
      stats: {
        total: repos.length,
        archived: repos.filter((r) => r.archived).length,
        forks: repos.filter((r) => r.fork).length,
        private: repos.filter((r) => r.private).length,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

/**
 * Import owned repos.
 * Body: { full_names?: string[], all_missing?: boolean, scan?: boolean, force_import?: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (body.scan) {
      const result = await scanAndMaybeImportOwned({
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

    const token = requireGithubToken();
    const settings = getSettings();
    const owned = await fetchOwnedRepos(token, {
      includeForks: settings.auto_import_owned_include_forks,
      includePrivate: settings.auto_import_owned_include_private,
    });

    let selected = owned;
    if (Array.isArray(body.full_names) && body.full_names.length > 0) {
      const want = new Set(body.full_names as string[]);
      selected = owned.filter((r) => want.has(r.full_name));
    } else if (body.all_missing) {
      selected = owned.filter((r) => !findRepo('github', r.owner, r.name));
    }

    if (selected.length === 0) {
      return NextResponse.json(
        { error: 'No repositories selected' },
        { status: 400 }
      );
    }

    const items = itemsFromOwned(selected);
    const job = startStarImport(items, [], 'manual-owned');

    return NextResponse.json({ ok: true, job, selected: items.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
