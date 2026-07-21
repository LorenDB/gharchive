import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getDefaultBranch, getBlob } from '@/lib/git';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { repos } = getDb();
  const repo = repos.find((r) => r.id === parseInt(params.id));

  if (!repo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  let ref = url.searchParams.get('ref') || '';

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  try {
    if (!ref) {
      ref = await getDefaultBranch(repo.mirror_path);
    }

    const blob = await getBlob(repo.mirror_path, ref, filePath);
    const name = filePath.split('/').pop() || filePath;

    return NextResponse.json({
      ref,
      path: filePath,
      name,
      ...blob,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to read file' },
      { status: 400 }
    );
  }
}
