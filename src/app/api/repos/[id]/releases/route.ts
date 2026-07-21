import { NextRequest, NextResponse } from 'next/server';
import { getDb, getReleaseAssets } from '@/lib/db';
import { withApiUser } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  return withApiUser(async () => {
    const { repos } = getDb();
    const repo = repos.find((r) => r.id === parseInt(params.id));

    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { releases } = getDb();
    const repoReleases = releases
      .filter((r) => r.repo_id === repo.id)
      .sort((a, b) => {
        if (!a.published_at && !b.published_at) return 0;
        if (!a.published_at) return 1;
        if (!b.published_at) return -1;
        return b.published_at.localeCompare(a.published_at);
      });

    for (const rel of repoReleases) {
      (rel as any).assets = getReleaseAssets(rel.id);
    }

    return NextResponse.json(repoReleases);
  });
}
