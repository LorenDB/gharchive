import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { syncRepo } from '@/lib/sync';
import { ensureApiAuth } from '@/lib/api-auth';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const denied = await ensureApiAuth();
  if (denied) return denied;
  const { repos } = getDb();
  const repo = repos.find((r) => r.id === parseInt(params.id));

  if (!repo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = await syncRepo(repo);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, messages: result.messages });
}
