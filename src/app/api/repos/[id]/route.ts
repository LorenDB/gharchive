import { NextRequest, NextResponse } from 'next/server';
import { getDb, deleteRepo } from '@/lib/db';
import { deleteMirror, mirrorStat } from '@/lib/git';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
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

  return NextResponse.json({
    repo: {
      ...repo,
      branch_count: stats.branchCount,
      tag_count: stats.tagCount,
      size_bytes: stats.sizeBytes,
    },
    syncLogs: repoLogs,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = parseInt(params.id);
  const { repos } = getDb();
  const repo = repos.find((r) => r.id === id);

  if (!repo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await deleteMirror(repo.mirror_path);
  deleteRepo(id);

  return NextResponse.json({ ok: true });
}
