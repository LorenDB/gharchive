/**
 * Pre-fetch API check to verify a repo still exists on the remote before
 * attempting git fetch. Avoids credential-prompt errors from HTTPS git
 * URLs when the repo is deleted (git tries interactive auth first, never
 * reaches the "repository not found" server response).
 */

import { knownApiKind } from '@/lib/platform';
import { forgejoApiBase, hostInfoFromCloneUrl } from '@/lib/forgejo';
import { isUnsafeOutboundHostname } from '@/lib/safe-url';

export interface RemoteExistsResult {
  /** true = definitely exists, false = definitely gone, null = unknown */
  exists: boolean | null;
  statusCode: number | null;
  message: string;
}

const CHECK_TIMEOUT_MS = 10_000;

export async function checkRemoteRepoExists(
  platform: string,
  owner: string,
  name: string,
  options: { cloneUrl?: string | null } = {}
): Promise<RemoteExistsResult> {
  const kind = knownApiKind(platform);

  if (kind === 'github') {
    return checkGithubRepoExists(owner, name);
  }
  if (kind === 'gitlab') {
    return checkGitlabRepoExists(owner, name);
  }
  if (kind === 'forgejo') {
    const host =
      hostInfoFromCloneUrl(options.cloneUrl) ?? {
        hostname: platform === 'codeberg' ? 'codeberg.org' : platform,
        port: null,
      };
    return checkForgejoRepoExists(host.hostname, owner, name, host.port);
  }

  return { exists: null, statusCode: null, message: 'no API for platform' };
}

async function checkGithubRepoExists(
  owner: string,
  name: string
): Promise<RemoteExistsResult> {
  try {
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
      { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }
    );

    if (res.status === 404 || res.status === 451) {
      return {
        exists: false,
        statusCode: res.status,
        message: `GitHub API: ${res.status}`,
      };
    }
    if (res.ok) {
      return { exists: true, statusCode: res.status, message: 'OK' };
    }
    return {
      exists: null,
      statusCode: res.status,
      message: `GitHub API: ${res.status}`,
    };
  } catch (err: any) {
    return {
      exists: null,
      statusCode: null,
      message: err?.message || String(err),
    };
  }
}

async function checkGitlabRepoExists(
  owner: string,
  name: string
): Promise<RemoteExistsResult> {
  try {
    const projectPath = `${owner}/${name}`;
    const encoded = encodeURIComponent(projectPath);
    const token = process.env.GITLAB_TOKEN;
    const headers: Record<string, string> = { 'User-Agent': 'gharchive' };
    if (token) headers['PRIVATE-TOKEN'] = token;

    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${encoded}`,
      { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }
    );

    if (res.status === 404) {
      return { exists: false, statusCode: 404, message: 'GitLab API: 404' };
    }
    if (res.ok) {
      return { exists: true, statusCode: res.status, message: 'OK' };
    }
    return {
      exists: null,
      statusCode: res.status,
      message: `GitLab API: ${res.status}`,
    };
  } catch (err: any) {
    return {
      exists: null,
      statusCode: null,
      message: err?.message || String(err),
    };
  }
}

async function checkForgejoRepoExists(
  hostname: string,
  owner: string,
  name: string,
  port?: string | null
): Promise<RemoteExistsResult> {
  try {
    if (isUnsafeOutboundHostname(hostname)) {
      return {
        exists: null,
        statusCode: null,
        message: 'host not allowed',
      };
    }
    const base = forgejoApiBase(hostname, port);
    const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'gharchive',
    };
    // Only attach forge tokens for Codeberg (or known public hosts) — never
    // for arbitrary self-hosted hostnames from clone URLs.
    const host = hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'codeberg.org') {
      const token =
        process.env.CODEBERG_TOKEN ||
        process.env.FORGEJO_TOKEN ||
        process.env.GITEA_TOKEN;
      if (token) headers['Authorization'] = `token ${token}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      redirect: 'manual',
    });

    if (res.status === 404) {
      return { exists: false, statusCode: 404, message: 'Forgejo API: 404' };
    }
    if (res.ok) {
      return { exists: true, statusCode: res.status, message: 'OK' };
    }
    return {
      exists: null,
      statusCode: res.status,
      message: `Forgejo API: ${res.status}`,
    };
  } catch (err: any) {
    return {
      exists: null,
      statusCode: null,
      message: err?.message || String(err),
    };
  }
}
