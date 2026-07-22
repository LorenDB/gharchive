import { getGithubToken } from '@/lib/db';

const GITHUB_API = 'https://api.github.com';
const GITHUB_GQL = 'https://api.github.com/graphql';

function hashToken(token: string): string {
  // Simple hash: use a truncated hex digest of the token for cache-key only
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ── In-memory TTL cache for GitHub API responses ────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL = 3_600_000; // 1 hour

function cached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return undefined;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, data: T, ttl = CACHE_TTL): void {
  map.set(key, { data, expiresAt: Date.now() + ttl });
}

const starsPreviewCache = new Map<string, CacheEntry<StarsPreview>>();
const ownedReposCache = new Map<string, CacheEntry<GhOwnedRepo[]>>();

export interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export interface GhStarredRepo {
  id: number;
  node_id: string;
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  private: boolean;
  language: string | null;
  stargazers_count: number;
  starred_at: string | null;
}

export interface GhStarList {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  /** full_name values in this list */
  repos: string[];
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'gharchive',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function validateGithubToken(token: string): Promise<GhUser> {
  const res = await fetch(`${GITHUB_API}/user`, { headers: headers(token) });
  if (res.status === 401) {
    throw new Error('Invalid GitHub token');
  }
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const u = await res.json();
  return {
    login: u.login,
    name: u.name,
    avatar_url: u.avatar_url,
    html_url: u.html_url,
  };
}

/** Paginate starred repos for the authenticated user. */
export async function fetchStarredRepos(
  token: string
): Promise<GhStarredRepo[]> {
  const results: GhStarredRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${GITHUB_API}/user/starred?per_page=${perPage}&page=${page}&sort=created&direction=desc`;
    const res = await fetch(url, {
      headers: {
        ...headers(token),
        // star+json includes starred_at
        Accept: 'application/vnd.github.star+json',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch stars: GitHub ${res.status}`);
    }
    const batch: any[] = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const item of batch) {
      // With star+json media type, payload is { starred_at, repo }
      const repo = item.repo || item;
      const starredAt = item.starred_at || null;
      if (!repo?.full_name) continue;
      results.push({
        id: repo.id,
        node_id: repo.node_id,
        full_name: repo.full_name,
        owner: repo.owner?.login || repo.full_name.split('/')[0],
        name: repo.name,
        description: repo.description,
        html_url: repo.html_url,
        clone_url: repo.clone_url || `${repo.html_url}.git`,
        private: Boolean(repo.private),
        language: repo.language,
        stargazers_count: repo.stargazers_count || 0,
        starred_at: starredAt,
      });
    }

    if (batch.length < perPage) break;
    page++;
    if (page > 50) break; // safety: 5000 stars max for now
  }

  return results;
}

/**
 * Fetch the authenticated user's GitHub star lists (UserList) via GraphQL.
 * Lists are a GraphQL-only feature; REST has no equivalent.
 */
export async function fetchStarLists(token: string): Promise<GhStarList[]> {
  const lists: GhStarList[] = [];
  let listCursor: string | null = null;

  do {
    const query = `
      query($listCursor: String) {
        viewer {
          lists(first: 32, after: $listCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              name
              description
              isPrivate
              items(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on Repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    `;

    const gqlRes: Response = await fetch(GITHUB_GQL, {
      method: 'POST',
      headers: {
        ...headers(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { listCursor } }),
    });

    if (!gqlRes.ok) {
      throw new Error(`GitHub GraphQL error: ${gqlRes.status}`);
    }

    const gqlBody: any = await gqlRes.json();
    if (gqlBody.errors?.length) {
      // Lists field may be unavailable for some tokens / accounts
      const msg = gqlBody.errors.map((e: any) => e.message).join('; ');
      if (/lists/i.test(msg) || /field/i.test(msg)) {
        console.warn('[github] star lists unavailable:', msg);
        return [];
      }
      throw new Error(msg);
    }

    const conn: any = gqlBody.data?.viewer?.lists;
    if (!conn) break;

    for (const node of conn.nodes || []) {
      if (!node) continue;
      const repos: string[] = [];
      for (const item of node.items?.nodes || []) {
        if (item?.nameWithOwner) repos.push(item.nameWithOwner);
      }

      // Paginate list items if needed
      let itemCursor = node.items?.pageInfo?.hasNextPage
        ? node.items.pageInfo.endCursor
        : null;
      while (itemCursor) {
        const more = await fetchListItemsPage(token, node.id, itemCursor);
        repos.push(...more.repos);
        itemCursor = more.nextCursor;
      }

      lists.push({
        id: node.id,
        name: node.name,
        description: node.description,
        isPrivate: Boolean(node.isPrivate),
        repos,
      });
    }

    listCursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (listCursor);

  return lists;
}

async function fetchListItemsPage(
  token: string,
  listId: string,
  after: string
): Promise<{ repos: string[]; nextCursor: string | null }> {
  const query = `
    query($id: ID!, $after: String) {
      node(id: $id) {
        ... on UserList {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on Repository { nameWithOwner }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(GITHUB_GQL, {
    method: 'POST',
    headers: {
      ...headers(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { id: listId, after } }),
  });
  if (!res.ok) return { repos: [], nextCursor: null };
  const body = await res.json();
  const items = body.data?.node?.items;
  const repos: string[] = [];
  for (const n of items?.nodes || []) {
    if (n?.nameWithOwner) repos.push(n.nameWithOwner);
  }
  const nextCursor = items?.pageInfo?.hasNextPage
    ? items.pageInfo.endCursor
    : null;
  return { repos, nextCursor };
}

export interface GhOwnedRepo {
  id: number;
  node_id: string;
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  private: boolean;
  fork: boolean;
  language: string | null;
  stargazers_count: number;
  archived: boolean;
  default_branch: string | null;
}

/**
 * Repositories owned by the authenticated user (not org collab-only).
 * Uses affiliation=owner to exclude pure collaborator repos.
 */
export async function fetchOwnedRepos(
  token: string,
  opts: { includeForks?: boolean; includePrivate?: boolean } = {}
): Promise<GhOwnedRepo[]> {
  const includeForks = opts.includeForks ?? false;
  const includePrivate = opts.includePrivate ?? true;
  const cacheKey = `stars\0${hashToken(token)}`;

  const hit = cached(ownedReposCache, cacheKey);
  if (hit) return hit;

  const results: GhOwnedRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url =
      `${GITHUB_API}/user/repos?affiliation=owner&per_page=${perPage}` +
      `&page=${page}&sort=updated&direction=desc`;
    const res = await fetch(url, { headers: headers(token) });
    if (!res.ok) {
      throw new Error(`Failed to fetch owned repos: GitHub ${res.status}`);
    }
    const batch: any[] = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const repo of batch) {
      if (!repo?.full_name) continue;
      if (!includeForks && repo.fork) continue;
      if (!includePrivate && repo.private) continue;
      results.push({
        id: repo.id,
        node_id: repo.node_id,
        full_name: repo.full_name,
        owner: repo.owner?.login || repo.full_name.split('/')[0],
        name: repo.name,
        description: repo.description,
        html_url: repo.html_url,
        clone_url: repo.clone_url || `${repo.html_url}.git`,
        private: Boolean(repo.private),
        fork: Boolean(repo.fork),
        language: repo.language,
        stargazers_count: repo.stargazers_count || 0,
        archived: Boolean(repo.archived),
        default_branch: repo.default_branch || null,
      });
    }

    if (batch.length < perPage) break;
    page++;
    if (page > 50) break;
  }

  setCached(ownedReposCache, cacheKey, results);
  return results;
}

export interface StarsPreview {
  user: GhUser;
  stars: GhStarredRepo[];
  lists: GhStarList[];
  /** full_name → github list ids */
  membership: Record<string, string[]>;
  unlisted: string[];
}

/** Full preview: stars + lists + which list(s) each star belongs to. */
export async function fetchStarsPreview(
  token?: string
): Promise<StarsPreview> {
  const t = token || getGithubToken();
  if (!t) throw new Error('No GitHub token configured');

  const cacheKey = `starspreview\0${hashToken(t)}`;
  const hit = cached(starsPreviewCache, cacheKey);
  if (hit) return hit;

  const [user, stars, lists] = await Promise.all([
    validateGithubToken(t),
    fetchStarredRepos(t),
    fetchStarLists(t),
  ]);

  const membership: Record<string, string[]> = {};
  const listed = new Set<string>();

  for (const list of lists) {
    for (const full of list.repos) {
      listed.add(full);
      if (!membership[full]) membership[full] = [];
      membership[full].push(list.id);
    }
  }

  const unlisted = stars
    .map((s) => s.full_name)
    .filter((n) => !listed.has(n));

  const result = { user, stars, lists, membership, unlisted };
  setCached(starsPreviewCache, cacheKey, result);
  return result;
}
