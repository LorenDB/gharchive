import { NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  addRepo,
  getRepoLists,
  setRepoLists,
  getLists,
} from '@/lib/db';
import { getMirrorPath, cloneMirror } from '@/lib/git';
import { parseCloneUrl } from '@/lib/releases';
import { syncRepo } from '@/lib/sync';
import { withApiUser } from '@/lib/api-auth';

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
  return withApiUser(async () => {
    try {
      const body = await req.json();
      const { clone_url } = body;
      if (!clone_url || typeof clone_url !== 'string') {
        return NextResponse.json({ error: 'clone_url is required' }, { status: 400 });
      }

      const { platform, owner, repo } = parseCloneUrl(clone_url);
      const mirrorPath = getMirrorPath(platform, owner, repo);

      const existing = getDb().repos.find(
        (r) => r.platform === platform && r.owner === owner && r.name === repo
      );
      if (existing) {
        return NextResponse.json({ error: 'Repository already archived' }, { status: 409 });
      }

      await cloneMirror(clone_url, mirrorPath);

      const newRepo = addRepo({
        platform,
        owner,
        name: repo,
        clone_url,
        mirror_path: mirrorPath,
        last_synced_at: null,
      });

      // Optional list assignment on create
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
        await syncRepo(newRepo, { skipGit: true });
      } catch (syncErr: any) {
        console.error('Initial sync after add failed:', syncErr?.message);
      }

      const fresh = getDb().repos.find((r) => r.id === newRepo.id) || newRepo;
      const { mirror_path, clone_url: _, ...safe } = fresh;
      return NextResponse.json(
        { ...safe, lists: getRepoLists(fresh.id) },
        { status: 201 }
      );
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
