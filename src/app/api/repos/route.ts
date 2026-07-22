import { NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  findRepo,
  findPublicArchive,
  createArchive,
  linkUserToArchive,
  getRepoLists,
  setRepoLists,
  getLists,
  getList,
  updateArchive,
} from '@/lib/db';
import { getMirrorPath, cloneMirror } from '@/lib/git';
import { parseCloneUrl } from '@/lib/releases';
import { syncRepo } from '@/lib/sync';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import { getImportStatus, enqueueRepoImport, type ImportItem } from '@/lib/import-stars';
import { fetchRemoteRepoMeta } from '@/lib/remote-meta';
import { tryGetUserId } from '@/lib/user-context';

export async function GET(req: NextRequest) {
  return withApiUser(async () => {
    const { repos } = getDb();
    const listIdParam = req.nextUrl.searchParams.get('list_id');
    const listId = listIdParam ? parseInt(listIdParam, 10) : null;

    let filtered = repos;
    if (listId && !isNaN(listId)) {
      filtered = repos.filter((r) =>
        getRepoLists(r.id).some((l) => l.id === listId)
      );
    }

    return NextResponse.json(
      filtered
        .map(({ clone_url, mirror_path, ...rest }) => ({
          id: rest.id,
          platform: rest.platform,
          owner: rest.owner,
          name: rest.name,
          last_synced_at: rest.last_synced_at,
          created_at: rest.created_at,
          from_star: rest.from_star,
          from_owned: rest.from_owned,
          remote_description: rest.remote_description ?? null,
          local_description: rest.local_description ?? null,
          language: rest.language ?? null,
          topics: rest.topics ?? [],
          stargazers_count: rest.stargazers_count ?? null,
          is_archived: Boolean(rest.is_archived),
          is_private: Boolean(rest.is_private),
          is_fork: Boolean(rest.is_fork),
          lists: getRepoLists(rest.id).map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
            source: l.source,
          })),
        }))
        .sort((a, b) => b.id - a.id)
    );
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
          github_list_ids: [],
          local_list_names: listNames.length ? listNames : undefined,
        };

        return NextResponse.json(
          { queued: true, message: 'Added to import queue — will be processed next', job: enqueueRepoImport(item) },
          { status: 202 }
        );
      }

      // Probe privacy (best-effort) before choosing path / share decision
      let isPrivate = false;
      try {
        const meta = await fetchRemoteRepoMeta(platform, owner, repo);
        if (meta) isPrivate = Boolean(meta.is_private);
      } catch {
        // treat as public for path choice
      }

      let newRepo;
      let linkedOnly = false;

      if (!isPrivate) {
        const shared = findPublicArchive(platform, owner, repo);
        if (shared) {
          newRepo = linkUserToArchive(shared.id, {});
          linkedOnly = true;
        }
      }

      if (!newRepo) {
        const mirrorPath = getMirrorPath(platform, owner, repo, {
          isPrivate,
          userId: tryGetUserId() || undefined,
        });
        await cloneMirror(clone_url, mirrorPath);

        const archive = createArchive({
          platform,
          owner,
          name: repo,
          clone_url,
          mirror_path: mirrorPath,
          last_synced_at: null,
          is_private: isPrivate,
        });
        newRepo = linkUserToArchive(archive.id, {});
      }

      if (Array.isArray(body.list_ids) && body.list_ids.length) {
        const valid = new Set(getLists().map((l) => l.id));
        setRepoLists(
          newRepo.id,
          body.list_ids
            .map((n: any) => parseInt(n, 10))
            .filter((id: number) => valid.has(id))
        );
      }

      try {
        await syncRepo(newRepo, { skipGit: linkedOnly ? false : true });
      } catch (syncErr: any) {
        console.error('Initial sync after add failed:', syncErr?.message);
      }

      // Refresh privacy from meta if we linked or just synced
      const fresh = getDb().repos.find((r) => r.id === newRepo!.id) || newRepo;
      // If meta revealed private after creating a public archive, mark it —
      // only safe when this is the sole member (always true for new create).
      if (fresh.is_private && fresh.archive_id) {
        updateArchive(fresh.archive_id, { is_private: true });
      }

      const { mirror_path, clone_url: _, ...safe } = fresh;
      return NextResponse.json(
        { ...safe, lists: getRepoLists(fresh.id), linked: linkedOnly },
        { status: 201 }
      );
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
