import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  getDefaultBranch,
  listBranches,
  listTags,
  listTree,
  getCommitInfo,
} from '@/lib/git';
import { withApiUser } from '@/lib/api-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  return withApiUser(async () => {
    const { repos } = getDb();
    const repo = repos.find((r) => r.id === parseInt(params.id));

    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '';
    let ref = url.searchParams.get('ref') || '';

    try {
      if (!ref) {
        ref = await getDefaultBranch(repo.mirror_path);
      }

      const [entries, branches, tags, commit] = await Promise.all([
        listTree(repo.mirror_path, ref, path),
        listBranches(repo.mirror_path),
        listTags(repo.mirror_path),
        getCommitInfo(repo.mirror_path, ref),
      ]);

      return NextResponse.json({
        ref,
        path,
        entries,
        branches,
        tags,
        commit,
      });
    } catch (err: any) {
      return NextResponse.json(
        { error: err.message || 'Failed to list tree' },
        { status: 400 }
      );
    }
  });
}
