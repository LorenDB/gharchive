import path from 'path';
import fs from 'fs';
import {
  AUTOLOGIN_USER_ID,
  safeUserPathSegment,
  tryGetUserId,
} from '@/lib/user-context';
import { hasEnoughMemory } from '@/lib/memory';
import { assertSafePathSegment } from '@/lib/git';
import { parseTrustedAssetUrl } from '@/lib/safe-url';

function getReleasesDir(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'releases');
}

export interface ReleaseData {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: AssetData[];
}

export interface AssetData {
  name: string;
  content_type: string;
  size: number;
  download_url: string;
}

function finalizeCloneIdentity(
  platform: 'github' | 'gitlab',
  repoPath: string
): {
  platform: 'github' | 'gitlab';
  owner: string;
  repo: string;
  projectPath: string;
} {
  const parts = repoPath
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/\.git$/, ''));
  if (parts.length < 2) throw new Error('Invalid repo URL');
  // GitHub is always owner/name (optionally with extra noise we reject)
  if (platform === 'github' && parts.length !== 2) {
    throw new Error('Invalid repo URL');
  }
  // GitLab may have nested groups — first segment owner, last segment name for
  // on-disk layout; projectPath keeps the full path for API calls.
  const ownerSeg = parts[0]!;
  const nameSeg = parts[parts.length - 1]!;
  assertSafePathSegment(ownerSeg, 'owner');
  assertSafePathSegment(nameSeg, 'repo');
  for (const p of parts) {
    if (p === '.' || p === '..' || !p) {
      throw new Error('Invalid repo URL');
    }
  }
  return {
    platform,
    owner: ownerSeg,
    repo: nameSeg,
    projectPath: parts.join('/'),
  };
}

export function parseCloneUrl(url: string): {
  platform: 'github' | 'gitlab';
  owner: string;
  repo: string;
  projectPath: string;
} {
  if (!url || typeof url !== 'string' || url.length > 2000) {
    throw new Error('Invalid repository URL');
  }
  if (/[\0\n\r;|&$`"'\\]/.test(url)) {
    throw new Error('Invalid repository URL: unsafe characters');
  }

  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');

  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const repoPath = sshMatch[2];
    if (host === 'github.com') {
      return finalizeCloneIdentity('github', repoPath);
    }
    if (host === 'gitlab.com') {
      return finalizeCloneIdentity('gitlab', repoPath);
    }
  }

  const httpsMatch = cleaned.match(/^https:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    const host = httpsMatch[1].replace(/^www\./, '');
    const repoPath = httpsMatch[2];
    // Reject userinfo smuggled into host
    if (host.includes('@')) {
      throw new Error('Invalid repository URL');
    }
    if (host === 'github.com') {
      return finalizeCloneIdentity('github', repoPath);
    }
    if (host === 'gitlab.com') {
      return finalizeCloneIdentity('gitlab', repoPath);
    }
  }

  throw new Error(
    `Unsupported repository URL: ${url}. Only github.com and gitlab.com (https or SSH) are supported.`
  );
}

export async function fetchReleases(
  platform: 'github' | 'gitlab',
  projectPath: string
): Promise<ReleaseData[]> {
  if (platform === 'github') {
    return fetchGitHubReleases(projectPath);
  }
  return fetchGitLabReleases(projectPath);
}

async function fetchGitHubReleases(repoPath: string): Promise<ReleaseData[]> {
  const url = `https://api.github.com/repos/${repoPath}/releases?per_page=100`;
  // Lazy import to avoid circular deps at module init
  const { getGithubToken } = await import('@/lib/db');
  const token = getGithubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gharchive',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

  const releases: any[] = await res.json();
  return releases.map((r) => ({
    tag_name: r.tag_name,
    name: r.name || r.tag_name,
    body: r.body || '',
    published_at: r.published_at || r.created_at,
    assets: (r.assets || []).map((a: any) => ({
      name: a.name,
      content_type: a.content_type,
      size: a.size,
      download_url: a.browser_download_url,
    })),
  }));
}

async function fetchGitLabReleases(projectPath: string): Promise<ReleaseData[]> {
  const encoded = encodeURIComponent(projectPath);
  const url = `https://gitlab.com/api/v4/projects/${encoded}/releases?per_page=100`;
  const token = process.env.GITLAB_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers['PRIVATE-TOKEN'] = token;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitLab API error: ${res.status}`);

  const releases: any[] = await res.json();
  return releases.map((r) => ({
    tag_name: r.tag_name,
    name: r.name || r.tag_name,
    body: r.description || '',
    published_at: r.released_at || r.created_at,
    assets: [
      ...(r.assets?.links || []).map((a: any) => ({
        name: a.name,
        content_type: 'application/octet-stream',
        size: 0,
        download_url: a.direct_asset_url || a.url,
      })),
      ...(r.assets?.sources || []).map((s: any) => ({
        name: `${r.tag_name}.${s.format || 'tar.gz'}`,
        content_type: 'application/octet-stream',
        size: 0,
        download_url: s.url,
      })),
    ],
  }));
}

export async function downloadReleaseAsset(
  url: string,
  destPath: string
): Promise<boolean> {
  try {
    const trusted = parseTrustedAssetUrl(url);
    if (!trusted) {
      console.warn(`[releases] refusing untrusted asset URL: ${url.slice(0, 120)}`);
      return false;
    }

    const memCheck = hasEnoughMemory(64);
    if (!memCheck.ok) {
      console.warn(`[releases] skipping asset download (${memCheck.reason}): ${url}`);
      return false;
    }

    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const token = process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN;
    const headers: Record<string, string> = { 'User-Agent': 'gharchive' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Manual redirect follow so we re-validate host on every hop (SSRF).
    let current = trusted;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(current.toString(), {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return false;
        const next = parseTrustedAssetUrl(new URL(loc, current).toString());
        if (!next) {
          console.warn(
            `[releases] asset redirect to untrusted host blocked: ${loc.slice(0, 120)}`
          );
          return false;
        }
        current = next;
        continue;
      }
      break;
    }
    if (!res || !res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

export type ReleasePathOptions = {
  /** Private archives isolate assets per user; public share one tree. */
  isPrivate?: boolean;
  userId?: string;
};

/**
 * On-disk path for a downloaded release asset.
 * - Public (shared): `releases/{platform}/{owner}/{repo}/{tag}/{file}`
 * - Private: `releases/users/{userId}/{platform}/{owner}/{repo}/{tag}/{file}`
 */
export function getReleaseAssetPath(
  platform: string,
  owner: string,
  repo: string,
  tag: string,
  filename: string,
  options?: ReleasePathOptions | string
): string {
  const safePlatform = assertSafePathSegment(platform, 'platform');
  const safeOwner = assertSafePathSegment(owner, 'owner');
  const safeRepo = assertSafePathSegment(repo, 'repo');
  const safeTag = assertSafePathSegment(tag, 'tag');
  const safeFilename = assertSafePathSegment(filename, 'filename');
  const opts: ReleasePathOptions =
    typeof options === 'string' ? { userId: options } : options || {};
  const releasesDir = getReleasesDir();
  const isPrivate = Boolean(opts.isPrivate);
  if (!isPrivate) {
    return path.join(releasesDir, safePlatform, safeOwner, safeRepo, safeTag, safeFilename);
  }
  const uid = opts.userId ?? tryGetUserId() ?? AUTOLOGIN_USER_ID;
  return path.join(
    releasesDir,
    'users',
    safeUserPathSegment(uid),
    safePlatform,
    safeOwner,
    safeRepo,
    safeTag,
    safeFilename
  );
}
