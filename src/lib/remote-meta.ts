/**
 * Fetch repository metadata (description, topics, language, etc.)
 * from GitHub, GitLab, or Forgejo/Gitea APIs for display on the repo detail page.
 */

import { knownApiKind } from '@/lib/platform';
import {
  fetchForgejoRepoMeta,
  hostInfoFromCloneUrl,
  resolveForgejoHost,
} from '@/lib/forgejo';

export interface RemoteRepoMeta {
  remote_description: string | null;
  topics: string[];
  language: string | null;
  homepage: string | null;
  stargazers_count: number | null;
  forks_count: number | null;
  license: string | null;
  is_private: boolean;
  is_archived: boolean;
  is_fork: boolean;
  remote_updated_at: string | null;
}

export type FetchRemoteMetaOptions = {
  /** Clone URL used to resolve host/port for Forgejo detection & API base. */
  cloneUrl?: string | null;
};

export async function fetchRemoteRepoMeta(
  platform: string,
  owner: string,
  name: string,
  options: FetchRemoteMetaOptions = {}
): Promise<RemoteRepoMeta | null> {
  try {
    const kind = knownApiKind(platform);
    if (kind === 'github') {
      return await fetchGithubMeta(owner, name);
    }
    if (kind === 'gitlab') {
      return await fetchGitlabMeta(owner, name);
    }
    if (kind === 'forgejo') {
      const host =
        hostInfoFromCloneUrl(options.cloneUrl) ?? {
          hostname: platform === 'codeberg' ? 'codeberg.org' : platform,
          port: null,
        };
      return await fetchForgejoRepoMeta(
        host.hostname,
        owner,
        name,
        host.port
      );
    }

    // Arbitrary host: probe for Forgejo/Gitea API
    const host = hostInfoFromCloneUrl(options.cloneUrl) ?? {
      hostname: platform,
      port: null,
    };
    if (!host.hostname) return null;

    const isForgejo = await resolveForgejoHost(host.hostname, host.port);
    if (!isForgejo) return null;

    return await fetchForgejoRepoMeta(
      host.hostname,
      owner,
      name,
      host.port
    );
  } catch (err: any) {
    console.warn(
      `[remote-meta] ${platform}:${owner}/${name}:`,
      err?.message || err
    );
    return null;
  }
}

async function fetchGithubMeta(
  owner: string,
  name: string
): Promise<RemoteRepoMeta> {
  const { getGithubToken } = await import('@/lib/db');
  const token = getGithubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gharchive',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }
  const r = await res.json();

  // Topics may also come from a separate Accept header; REST returns topics
  // when Accept is application/vnd.github+json (or with mercurial preview).
  const topics: string[] = Array.isArray(r.topics)
    ? r.topics.filter((t: unknown) => typeof t === 'string')
    : [];

  return {
    remote_description:
      typeof r.description === 'string' ? r.description : null,
    topics,
    language: typeof r.language === 'string' ? r.language : null,
    homepage: typeof r.homepage === 'string' && r.homepage ? r.homepage : null,
    stargazers_count:
      typeof r.stargazers_count === 'number' ? r.stargazers_count : null,
    forks_count: typeof r.forks_count === 'number' ? r.forks_count : null,
    license: r.license?.spdx_id || r.license?.name || null,
    is_private: Boolean(r.private),
    is_archived: Boolean(r.archived),
    is_fork: Boolean(r.fork),
    remote_updated_at:
      typeof r.pushed_at === 'string'
        ? r.pushed_at
        : typeof r.updated_at === 'string'
          ? r.updated_at
          : null,
  };
}

async function fetchGitlabMeta(
  owner: string,
  name: string
): Promise<RemoteRepoMeta> {
  // GitLab project path may be nested (group/subgroup/project)
  const projectPath = `${owner}/${name}`;
  const encoded = encodeURIComponent(projectPath);
  const token = process.env.GITLAB_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'gharchive',
  };
  if (token) headers['PRIVATE-TOKEN'] = token;

  const res = await fetch(
    `https://gitlab.com/api/v4/projects/${encoded}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`GitLab API error: ${res.status}`);
  }
  const r = await res.json();

  const topics: string[] = [];
  if (Array.isArray(r.topics)) {
    for (const t of r.topics) {
      if (typeof t === 'string') topics.push(t);
    }
  } else if (Array.isArray(r.tag_list)) {
    // Older GitLab used tag_list
    for (const t of r.tag_list) {
      if (typeof t === 'string') topics.push(t);
    }
  }

  return {
    remote_description:
      typeof r.description === 'string' ? r.description : null,
    topics,
    language: null, // GitLab project endpoint doesn't include primary language
    // GitLab has no first-class homepage field like GitHub
    homepage: null,
    stargazers_count:
      typeof r.star_count === 'number' ? r.star_count : null,
    forks_count: typeof r.forks_count === 'number' ? r.forks_count : null,
    license: r.license?.key || r.license?.name || null,
    is_private: r.visibility === 'private' || r.visibility === 'internal',
    is_archived: Boolean(r.archived),
    is_fork: Boolean(r.forked_from_project),
    remote_updated_at:
      typeof r.last_activity_at === 'string'
        ? r.last_activity_at
        : typeof r.updated_at === 'string'
          ? r.updated_at
          : null,
  };
}

/**
 * Common README filenames tried in order (case-sensitive git paths).
 * Markdown variants first, then plain-text fallbacks (README / README.txt).
 */
export const README_CANDIDATES = [
  // Markdown — rendered with GFM + sanitized HTML
  'README.md',
  'readme.md',
  'Readme.md',
  'README.MD',
  'README.markdown',
  'readme.markdown',
  'README.mdown',
  // Plain text — monospace, no markdown
  'README',
  'readme',
  'README.txt',
  'readme.txt',
  'Readme.txt',
  // Other plain-ish formats (shown as mono; no RST parser)
  'README.rst',
  'readme.rst',
];

/** True when the path should be rendered as Markdown (not plain mono). */
export function isReadmeMarkdown(path: string | null | undefined): boolean {
  if (!path) return false;
  return /\.(md|markdown|mdown)$/i.test(path);
}
