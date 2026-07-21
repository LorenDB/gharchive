import { NextRequest, NextResponse } from 'next/server';
import {
  getList,
  updateList,
  deleteList,
  getListCounts,
  getListRepoIds,
  getDb,
} from '@/lib/db';
import { ensureApiAuth } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  const id = parseInt(params.id, 10);
  const list = getList(id);
  if (!list) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const counts = getListCounts();
  const repoIds = new Set(getListRepoIds(id));
  const repos = getDb()
    .repos.filter((r) => repoIds.has(r.id))
    .map(({ clone_url, mirror_path, ...rest }) => rest);

  return NextResponse.json({
    list: { ...list, repo_count: counts[id] || 0 },
    repos,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  const id = parseInt(params.id, 10);
  if (!getList(id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await req.json();
    const updates: Parameters<typeof updateList>[1] = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      }
      updates.name = name;
    }
    if (body.description !== undefined) {
      updates.description =
        typeof body.description === 'string'
          ? body.description.trim() || null
          : null;
    }
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) {
      updates.color = body.color;
    }

    const list = updateList(id, updates);
    const counts = getListCounts();
    return NextResponse.json({
      list: { ...list!, repo_count: counts[id] || 0 },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  const id = parseInt(params.id, 10);
  if (!getList(id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  deleteList(id);
  return NextResponse.json({ ok: true });
}
