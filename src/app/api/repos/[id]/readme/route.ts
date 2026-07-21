import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getDefaultBranch, getReadmeBlob } from '@/lib/git';
import { README_CANDIDATES, isReadmeMarkdown } from '@/lib/remote-meta';
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
    let ref = url.searchParams.get('ref') || '';

    try {
      if (!ref) {
        ref = await getDefaultBranch(repo.mirror_path);
      }

      const readme = await getReadmeBlob(
        repo.mirror_path,
        ref,
        README_CANDIDATES
      );

      if (!readme) {
        return NextResponse.json({
          ref,
          found: false,
          path: null,
          content: null,
          size: 0,
          format: null,
        });
      }

      const format = isReadmeMarkdown(readme.path) ? 'markdown' : 'plain';

      return NextResponse.json({
        ref,
        found: true,
        path: readme.path,
        content: readme.content,
        size: readme.size,
        encoding: readme.encoding,
        format,
      });
    } catch (err: any) {
      return NextResponse.json(
        { error: err.message || 'Failed to read README' },
        { status: 400 }
      );
    }
  });
}
