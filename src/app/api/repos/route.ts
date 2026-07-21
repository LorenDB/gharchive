import { NextRequest, NextResponse } from 'next/server';
import { getDb, addRepo } from '@/lib/db';
import { getMirrorPath, cloneMirror } from '@/lib/git';
import { parseCloneUrl } from '@/lib/releases';
import { syncRepo } from '@/lib/sync';

export async function GET() {
  const { repos } = getDb();
  return NextResponse.json(
    repos
      .map(({ clone_url, mirror_path, ...rest }) => rest)
      .sort((a, b) => b.id - a.id)
  );
}

export async function POST(req: NextRequest) {
  try {
    const { clone_url } = await req.json();
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

    // Immediately sync releases (git is already fully cloned)
    try {
      await syncRepo(newRepo, { skipGit: true });
    } catch (syncErr: any) {
      // Repo is still usable; release sync can be retried manually
      console.error('Initial sync after add failed:', syncErr?.message);
    }

    // Re-read so last_synced_at is current
    const fresh = getDb().repos.find((r) => r.id === newRepo.id) || newRepo;
    const { mirror_path, clone_url: _, ...safe } = fresh;
    return NextResponse.json(safe, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
