import { NextRequest, NextResponse } from 'next/server';
import {
  findRepo,
  getList,
} from '@/lib/db';
import { parseCloneUrl } from '@/lib/releases';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { getImportStatus, enqueueRepoImport, type ImportItem } from '@/lib/import-stars';
import { getRepoCards } from '@/lib/server-data';

export async function GET(req: NextRequest) {
  return withApiUser(async () => {
    const listIdParam = req.nextUrl.searchParams.get('list_id');
    const parsed = listIdParam ? parseInt(listIdParam, 10) : NaN;
    const listId = Number.isFinite(parsed) ? parsed : null;
    return NextResponse.json(getRepoCards(listId));
  });
}

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const body = await req.json();
      const { clone_url } = body;
      if (!clone_url || typeof clone_url !== 'string') {
        return NextResponse.json({ error: 'clone_url is required' }, { status: 400 });
      }
      if (clone_url.length > 2000) {
        return NextResponse.json({ error: 'clone_url too long' }, { status: 400 });
      }

      const { platform, owner, repo } = parseCloneUrl(clone_url);

      const existing = findRepo(platform, owner, repo);
      if (existing) {
        return NextResponse.json({ error: 'Repository already archived' }, { status: 409 });
      }

      const importStatus = getImportStatus();
      if (importStatus.running) {
        const listIds: number[] = Array.isArray(body.list_ids) && body.list_ids.length
          ? body.list_ids
              .map((n: any) => parseInt(n, 10))
              .filter((id: number) => !isNaN(id))
          : [];
        const listNames: string[] = listIds
          .map((id) => getList(id)?.name)
          .filter((n): n is string => Boolean(n));

        const item: ImportItem = {
          owner,
          name: repo,
          clone_url,
          platform,
          github_list_ids: [],
          local_list_names: listNames.length ? listNames : undefined,
        };

        return NextResponse.json(
          { queued: true, message: 'Added to import queue — will be processed next', job: enqueueRepoImport(item) },
          { status: 202 }
        );
      }

      // Start async import so placeholder shows on dashboard immediately
      const item: ImportItem = {
        owner,
        name: repo,
        clone_url,
        platform,
        github_list_ids: [],
      };
      const job = enqueueRepoImport(item);

      return NextResponse.json(
        { queued: true, message: 'Import started', job },
        { status: 202 }
      );
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
