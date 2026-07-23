import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import {
  getDb,
  unlinkRepo,
  getRepoLists,
  getLists,
  updateRepo,
  getRepoById,
} from '@/lib/db';
import { deleteMirror, mirrorStat } from '@/lib/git';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  return withApiUser(async () => {
    const { repos, syncLogs } = getDb();
    const repo = repos.find((r) => r.id === parseInt(params.id));

    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const repoLogs = syncLogs
      .filter((l) => l.repo_id === repo.id)
      .sort((a, b) => b.id - a.id)
      .slice(0, 20);

    const stats = await mirrorStat(repo.mirror_path).catch(() => ({
      branchCount: 0,
      tagCount: 0,
      sizeBytes: 0,
    }));

    const { releases, releaseAssets } = getDb();
    const repoReleaseIds = new Set(
      releases
        .filter((r) => r.archive_id === repo.archive_id)
        .map((r) => r.id)
    );
    const assetSizeBytes = releaseAssets
      .filter(
        (a) =>
          repoReleaseIds.has(a.release_id) &&
          a.file_path &&
          fs.existsSync(a.file_path)
      )
      .reduce((sum, a) => sum + (a.size ?? 0), 0);

    // Strip on-disk mirror path from the API surface (clone_url is intentional)
    const { mirror_path: _mp, ...safeRepo } = repo;

    return NextResponse.json({
      repo: {
        ...safeRepo,
        branch_count: stats.branchCount,
        tag_count: stats.tagCount,
        size_bytes: stats.sizeBytes + assetSizeBytes,
        code_size_bytes: stats.sizeBytes,
        asset_size_bytes: assetSizeBytes,
        lists: getRepoLists(repo.id),
      },
      allLists: getLists(),
      syncLogs: repoLogs,
    });
  });
}

/** Update user-editable fields (local_description, release asset policy). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const rateLimited = checkRateLimit(req, { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    const id = parseInt(params.id, 10);
    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const repo = getRepoById(id);
    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const hasLocalDescription = 'local_description' in body;
    const hasReleaseMode = 'release_asset_mode' in body;
    const hasReleaseKeep = 'release_asset_keep_last' in body;

    if (!hasLocalDescription && !hasReleaseMode && !hasReleaseKeep) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      );
    }

    const updates: {
      local_description?: string | null;
      release_asset_mode?: 'all' | 'none' | 'last_n' | null;
      release_asset_keep_last?: number | null;
    } = {};

    if (hasLocalDescription) {
      let local_description: string | null = null;
      if (body.local_description != null) {
        if (typeof body.local_description !== 'string') {
          return NextResponse.json(
            { error: 'local_description must be a string' },
            { status: 400 }
          );
        }
        const trimmed = body.local_description.trim();
        if (trimmed.length > 10000) {
          return NextResponse.json(
            { error: 'local_description max length is 10000 characters' },
            { status: 400 }
          );
        }
        local_description = trimmed || null;
      }
      updates.local_description = local_description;
    }

    if (hasReleaseMode) {
      const mode = body.release_asset_mode;
      if (mode === null || mode === '' || mode === 'inherit') {
        updates.release_asset_mode = null;
      } else if (mode === 'all' || mode === 'none' || mode === 'last_n') {
        updates.release_asset_mode = mode;
      } else {
        return NextResponse.json(
          {
            error:
              'release_asset_mode must be all, none, last_n, or null (inherit)',
          },
          { status: 400 }
        );
      }
    }

    if (hasReleaseKeep) {
      if (
        body.release_asset_keep_last === null ||
        body.release_asset_keep_last === ''
      ) {
        updates.release_asset_keep_last = null;
      } else {
        const n = Number(body.release_asset_keep_last);
        if (!Number.isFinite(n) || n < 1 || n > 10_000) {
          return NextResponse.json(
            {
              error:
                'release_asset_keep_last must be between 1 and 10000, or null',
            },
            { status: 400 }
          );
        }
        updates.release_asset_keep_last = Math.round(n);
      }
    }

    updateRepo(id, updates);
    const updated = getRepoById(id)!;
    const { mirror_path: _mp, ...safeRepo } = updated;

    return NextResponse.json({
      repo: {
        ...safeRepo,
        lists: getRepoLists(updated.id),
      },
    });
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const rateLimited = checkRateLimit(req, { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    const id = parseInt(params.id);
    const repo = getRepoById(id);

    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const result = unlinkRepo(id);

    if (result.archiveDeleted) {
      if (result.mirrorPath) {
        await deleteMirror(result.mirrorPath);
      }
      for (const assetPath of result.assetPaths) {
        try {
          if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
        } catch {
          // best-effort asset cleanup
        }
      }
    }

    return NextResponse.json({
      ok: true,
      unlinked: result.unlinked,
      archive_deleted: result.archiveDeleted,
    });
  });
}
