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

    // Strip on-disk mirror path from the API surface (clone_url is intentional)
    const { mirror_path: _mp, ...safeRepo } = repo;

    return NextResponse.json({
      repo: {
        ...safeRepo,
        branch_count: stats.branchCount,
        tag_count: stats.tagCount,
        size_bytes: stats.sizeBytes,
        lists: getRepoLists(repo.id),
      },
      allLists: getLists(),
      syncLogs: repoLogs,
    });
  });
}

/** Update user-editable fields (currently local_description). */
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

    if (!('local_description' in body)) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      );
    }

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

    updateRepo(id, { local_description });
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
