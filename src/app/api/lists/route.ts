import { NextRequest, NextResponse } from 'next/server';
import {
  getLists,
  addList,
  LIST_COLORS,
} from '@/lib/db';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { getListFilters } from '@/lib/server-data';

export async function GET() {
  return withApiUser(async () => {
    return NextResponse.json({ lists: getListFilters() });
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const body = await req.json();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
      }
      if (name.length > 80) {
        return NextResponse.json({ error: 'name too long' }, { status: 400 });
      }

      const existing = getLists().find(
        (l) => l.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        return NextResponse.json(
          { error: 'A list with that name already exists' },
          { status: 409 }
        );
      }

      const color =
        typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)
          ? body.color
          : LIST_COLORS[getLists().length % LIST_COLORS.length];

      const list = addList({
        name,
        description:
          typeof body.description === 'string' ? body.description.trim() || null : null,
        color,
        source: 'local',
        github_list_id: null,
      });

      return NextResponse.json({ list: { ...list, repo_count: 0 } }, { status: 201 });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
