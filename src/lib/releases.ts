import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const RELEASES_DIR = path.join(DATA_DIR, 'releases');

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

export function parseCloneUrl(url: string): {
  platform: 'github' | 'gitlab';
  owner: string;
  repo: string;
  projectPath: string;
} {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');

  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const repoPath = sshMatch[2];
    if (host === 'github.com') {
      const [owner, ...rest] = repoPath.split('/');
      return { platform: 'github', owner, repo: rest.join('/'), projectPath: repoPath };
    }
    if (host === 'gitlab.com') {
      const [owner, ...rest] = repoPath.split('/');
      return { platform: 'gitlab', owner, repo: rest.join('/'), projectPath: repoPath };
    }
  }

  const httpsMatch = cleaned.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    const host = httpsMatch[1].replace(/^www\./, '');
    const repoPath = httpsMatch[2];
    if (host === 'github.com') {
      const [owner, ...rest] = repoPath.split('/');
      if (!owner || rest.length === 0) throw new Error('Invalid repo URL');
      return { platform: 'github', owner, repo: rest.join('/'), projectPath: repoPath };
    }
    if (host === 'gitlab.com') {
      const [owner, ...rest] = repoPath.split('/');
      if (!owner || rest.length === 0) throw new Error('Invalid repo URL');
      return { platform: 'gitlab', owner, repo: rest.join('/'), projectPath: repoPath };
    }
  }

  throw new Error(
    `Unsupported repository URL: ${url}. Only github.com and gitlab.com are supported.`
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
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const token = process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN;
    const headers: Record<string, string> = { 'User-Agent': 'gharchive' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

export function getReleaseAssetPath(
  platform: string,
  owner: string,
  repo: string,
  tag: string,
  filename: string
): string {
  return path.join(RELEASES_DIR, platform, owner, repo, tag, filename);
}
