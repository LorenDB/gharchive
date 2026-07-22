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
import { knownApiKind, platformFromHost } from '@/lib/platform';
import {
  fetchForgejoReleases,
  hostInfoFromCloneUrl,
  resolveForgejoHost,
} from '@/lib/forgejo';

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

export interface CloneIdentity {
  /** On-disk / dedup platform id (github, gitlab, codeberg, or hostname). */
  platform: string;
  owner: string;
  repo: string;
  projectPath: string;
  /** Original hostname (no www.), for API base resolution. */
  hostname: string;
  /** Port if present in the URL (https custom ports). */
  port: string | null;
}

function finalizeCloneIdentity(
  platform: string,
  hostname: string,
  repoPath: string,
  options: { strictTwoSegment?: boolean; port?: string | null } = {}
): CloneIdentity {
  const parts = repoPath
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/\.git$/, ''));
  if (parts.length < 2) throw new Error('Invalid repo URL');
  // GitHub / Codeberg / typical Forgejo: owner/name only
  if (options.strictTwoSegment && parts.length !== 2) {
    throw new Error('Invalid repo URL');
  }
  // GitLab (and unknown hosts) may have nested groups — first segment owner,
  // last segment name for on-disk layout; projectPath keeps the full path.
  const ownerSeg = parts[0]!;
  const nameSeg = parts[parts.length - 1]!;
  assertSafePathSegment(ownerSeg, 'owner');
  assertSafePathSegment(nameSeg, 'repo');
  // Platform may be a hostname (dots OK); still validate as path segment
  assertSafePathSegment(platform, 'platform');
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
    hostname,
    port: options.port ?? null,
  };
}

/**
 * Parse a git clone URL (https or SSH) into platform identity.
 * Known hosts map to short platform ids; anything else uses the hostname
 * as the platform so arbitrary forges can still be mirrored.
 */
export function parseCloneUrl(url: string): CloneIdentity {
  if (!url || typeof url !== 'string' || url.length > 2000) {
    throw new Error('Invalid repository URL');
  }
  if (/[\0\n\r;|&$`"'\\]/.test(url)) {
    throw new Error('Invalid repository URL: unsafe characters');
  }

  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');

  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const rawHost = sshMatch[1];
    const hostname = rawHost.toLowerCase().replace(/^www\./, '');
    const repoPath = sshMatch[2];
    const platform = platformFromHost(hostname);
    const kind = knownApiKind(platform);
    return finalizeCloneIdentity(platform, hostname, repoPath, {
      strictTwoSegment: kind === 'github' || kind === 'forgejo',
    });
  }

  const httpsMatch = cleaned.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (httpsMatch) {
    const hostPort = httpsMatch[1];
    // Reject userinfo smuggled into host
    if (hostPort.includes('@')) {
      throw new Error('Invalid repository URL');
    }
    let hostname = hostPort;
    let port: string | null = null;
    if (hostPort.includes(':')) {
      const [h, p] = hostPort.split(':');
      hostname = h!;
      port = p || null;
    }
    hostname = hostname.toLowerCase().replace(/^www\./, '');
    // IPv6 or empty host
    if (!hostname || hostname.startsWith('[')) {
      throw new Error('Invalid repository URL');
    }
    const repoPath = httpsMatch[2];
    const platform = platformFromHost(hostname);
    const kind = knownApiKind(platform);
    return finalizeCloneIdentity(platform, hostname, repoPath, {
      strictTwoSegment: kind === 'github' || kind === 'forgejo',
      port,
    });
  }

  throw new Error(
    `Unsupported repository URL: ${url}. Provide an https or SSH git clone URL (e.g. https://host/owner/repo.git).`
  );
}

export type FetchReleasesOptions = {
  /** Clone URL used to resolve host/port for Forgejo detection & API base. */
  cloneUrl?: string | null;
};

/**
 * Fetch release metadata for a repo.
 * - Returns a list (possibly empty) when a releases API was successfully used.
 * - Returns `null` when the host has no supported API (plain git mirror only)
 *   so callers do not treat that as an upstream wipe.
 */
export async function fetchReleases(
  platform: string,
  projectPath: string,
  options: FetchReleasesOptions = {}
): Promise<ReleaseData[] | null> {
  const kind = knownApiKind(platform);
  if (kind === 'github') {
    return fetchGitHubReleases(projectPath);
  }
  if (kind === 'gitlab') {
    return fetchGitLabReleases(projectPath);
  }
  if (kind === 'forgejo') {
    const host =
      hostInfoFromCloneUrl(options.cloneUrl) ?? {
        hostname: platform === 'codeberg' ? 'codeberg.org' : platform,
        port: null,
      };
    const parts = projectPath.split('/').filter(Boolean);
    const owner = parts[0]!;
    const name = parts[parts.length - 1]!;
    return fetchForgejoReleases(host.hostname, owner, name, host.port);
  }

  // Arbitrary host: auto-detect Forgejo/Gitea API
  const host = hostInfoFromCloneUrl(options.cloneUrl) ?? {
    hostname: platform,
    port: null,
  };
  if (!host.hostname) return null;

  const isForgejo = await resolveForgejoHost(host.hostname, host.port);
  if (!isForgejo) return null;

  const parts = projectPath.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const name = parts[parts.length - 1]!;
  return fetchForgejoReleases(host.hostname, owner, name, host.port);
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

export type DownloadAssetOptions = {
  /** Additional hostnames trusted for this download (e.g. repo's forge host). */
  extraTrustedHosts?: string[];
  /**
   * Called when an asset URL (or redirect) points at a host outside the
   * allowlist — used to queue a user approval prompt.
   */
  onUntrustedHost?: (hostname: string, url: string) => void;
};

function notifyUntrustedHost(
  rawUrl: string,
  onUntrustedHost?: (hostname: string, url: string) => void
): void {
  if (!onUntrustedHost) return;
  try {
    const u = new URL(rawUrl);
    if (u.hostname) onUntrustedHost(u.hostname.toLowerCase(), rawUrl);
  } catch {
    // ignore
  }
}

export async function downloadReleaseAsset(
  url: string,
  destPath: string,
  options: DownloadAssetOptions = {}
): Promise<boolean> {
  try {
    const trusted = parseTrustedAssetUrl(url, options.extraTrustedHosts);
    if (!trusted) {
      console.warn(`[releases] refusing untrusted asset URL: ${url.slice(0, 120)}`);
      notifyUntrustedHost(url, options.onUntrustedHost);
      return false;
    }

    const memCheck = hasEnoughMemory(64);
    if (!memCheck.ok) {
      console.warn(`[releases] skipping asset download (${memCheck.reason}): ${url}`);
      return false;
    }

    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GITLAB_TOKEN ||
      process.env.FORGEJO_TOKEN ||
      process.env.CODEBERG_TOKEN ||
      process.env.GITEA_TOKEN;
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
        const absolute = new URL(loc, current).toString();
        const next = parseTrustedAssetUrl(absolute, options.extraTrustedHosts);
        if (!next) {
          console.warn(
            `[releases] asset redirect to untrusted host blocked: ${loc.slice(0, 120)}`
          );
          notifyUntrustedHost(absolute, options.onUntrustedHost);
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
