import { NextResponse } from 'next/server';
import { findRepo, getGithubAccountPublic } from '@/lib/db';
import { fetchStarsPreview } from '@/lib/github';
import { requireGithubToken } from '@/lib/import-stars';
import { withApiUser } from '@/lib/api-auth';

/** Preview starred repos + GitHub lists (does not clone). */
export async function GET() {
  return withApiUser(async () => {
    try {
      const account = getGithubAccountPublic();
      if (!account) {
        return NextResponse.json(
          { error: 'Link a GitHub account in Settings first' },
          { status: 400 }
        );
      }

      const token = requireGithubToken();
      const preview = await fetchStarsPreview(token);

      // Annotate already-archived
      const stars = preview.stars.map((s) => {
        const existing = findRepo('github', s.owner, s.name);
        return {
          ...s,
          archived: Boolean(existing),
          archived_repo_id: existing?.id ?? null,
          list_ids: preview.membership[s.full_name] || [],
        };
      });

      return NextResponse.json({
        account,
        user: preview.user,
        stars,
        lists: preview.lists.map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
          isPrivate: l.isPrivate,
          count: l.repos.length,
          repos: l.repos,
        })),
        unlisted: preview.unlisted,
        membership: preview.membership,
        stats: {
          total_stars: stars.length,
          archived: stars.filter((s) => s.archived).length,
          lists: preview.lists.length,
          unlisted: preview.unlisted.length,
        },
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
