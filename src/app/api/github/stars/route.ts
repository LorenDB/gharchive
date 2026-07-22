import { NextResponse } from 'next/server';
import { buildRepoLookup, identityKey, uid, getGithubAccountPublic } from '@/lib/db';
import { fetchStarsPreview } from '@/lib/github';
import { requireGithubToken } from '@/lib/import-stars';
import { withApiUser } from '@/lib/api-auth';

const CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
};

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

      // Bulk lookup: O(repos + stars) instead of O(stars × repos)
      const userId = uid();
      const lookup = buildRepoLookup(userId);

      const stars = preview.stars.map((s) => {
        const existing = lookup.get(identityKey('github', s.owner, s.name));
        return {
          ...s,
          archived: Boolean(existing),
          archived_repo_id: existing?.id ?? null,
          list_ids: preview.membership[s.full_name] || [],
        };
      });

      return NextResponse.json(
        {
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
        },
        { headers: CACHE_HEADERS }
      );
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}
