import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { syncRepo } from '@/lib/sync';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const rateLimited = checkRateLimit(req, { maxRequests: 5, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
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
  });
}
