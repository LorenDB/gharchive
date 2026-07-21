import { NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  getRepoLists,
  setRepoLists,
  getLists,
} from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = parseInt(params.id, 10);
  const repo = getDb().repos.find((r) => r.id === id);
  if (!repo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({
    lists: getRepoLists(id),
    all_lists: getLists(),
  });
}

/** Replace list membership for a repo. Body: { list_ids: number[] } */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = parseInt(params.id, 10);
  const repo = getDb().repos.find((r) => r.id === id);
  if (!repo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const listIds = Array.isArray(body.list_ids)
      ? body.list_ids.map((n: any) => parseInt(n, 10)).filter((n: number) => !isNaN(n))
      : [];
    setRepoLists(id, listIds);
    return NextResponse.json({ lists: getRepoLists(id) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
