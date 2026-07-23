/**
 * Forgejo / Gitea-compatible API helpers (Codeberg and self-hosted).
 *
 * Detection probes `GET /api/v1/version` and caches the result per host for
 * the process lifetime so arbitrary forges can load remote meta + releases.
 */

import type { RemoteRepoMeta } from '@/lib/remote-meta';
import type { ReleaseData } from '@/lib/releases';
import { isUnsafeOutboundHostname } from '@/lib/safe-url';

const DETECT_TIMEOUT_MS = 4_000;
const API_TIMEOUT_MS = 30_000;

/** host (lowercased, no port) → is Forgejo/Gitea API */
const forgejoHostCache = new Map<string, boolean>();

export function clearForgejoHostCache(): void {
  forgejoHostCache.clear();
}

/** Known Forgejo/Gitea hosts that skip the version probe. */
const KNOWN_FORGEJO_HOSTS = new Set(['codeberg.org']);

export function isKnownForgejoHost(hostname: string): boolean {
  return KNOWN_FORGEJO_HOSTS.has(normalizeHostname(hostname));
}

export function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * API origin for a forge host. Uses https always (Forgejo serves API over TLS
 * on public hosts; self-hosted plain-http forges can still be cloned via git).
 */
export function forgejoApiOrigin(hostname: string, port?: string | null): string {
  const host = normalizeHostname(hostname);
  if (port && port !== '443' && port !== '80') {
    return `https://${host}:${port}`;
  }
  return `https://${host}`;
}

export function forgejoApiBase(hostname: string, port?: string | null): string {
  return `${forgejoApiOrigin(hostname, port)}/api/v1`;
}

/**
 * Extract hostname (+ optional port) from a clone URL for API calls.
 */
export function hostInfoFromCloneUrl(cloneUrl: string | null | undefined): {
  hostname: string;
  port: string | null;
} | null {
  if (!cloneUrl || typeof cloneUrl !== 'string') return null;
  const cleaned = cloneUrl.trim();
  if (!cleaned) return null;

  const ssh = cleaned.match(/^git@([^:]+):/);
  if (ssh) {
    return { hostname: normalizeHostname(ssh[1]), port: null };
  }

  try {
    if (/^https?:\/\//i.test(cleaned)) {
      const u = new URL(cleaned);
      return {
        hostname: normalizeHostname(u.hostname),
        port: u.port || null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Probe whether a host exposes a Forgejo/Gitea-compatible API.
 * Cached for the process lifetime. Failures cache as false.
 */
export async function detectForgejoHost(
  hostname: string,
  port?: string | null
): Promise<boolean> {
  const key = port && port !== '443' && port !== '80'
    ? `${normalizeHostname(hostname)}:${port}`
    : normalizeHostname(hostname);

  if (forgejoHostCache.has(key)) {
    return forgejoHostCache.get(key)!;
  }
  if (isKnownForgejoHost(hostname)) {
    forgejoHostCache.set(key, true);
    return true;
  }

  // Avoid probing non-host strings / empty
  if (!key || key.includes('/') || key.includes(' ')) {
    forgejoHostCache.set(key, false);
    return false;
  }

  // Never probe loopback / cloud-metadata (SSRF)
  if (isUnsafeOutboundHostname(hostname)) {
    forgejoHostCache.set(key, false);
    return false;
  }

  try {
    const url = `${forgejoApiBase(hostname, port)}/version`;
    // Manual redirects: only follow same-host hops so a public host cannot
    // bounce the probe onto an internal/metadata address.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetch(current, {
        headers: { 'User-Agent': 'gharchive', Accept: 'application/json' },
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          forgejoHostCache.set(key, false);
          return false;
        }
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          forgejoHostCache.set(key, false);
          return false;
        }
        if (next.protocol !== 'https:') {
          forgejoHostCache.set(key, false);
          return false;
        }
        if (
          isUnsafeOutboundHostname(next.hostname) ||
          normalizeHostname(next.hostname) !== normalizeHostname(hostname)
        ) {
          forgejoHostCache.set(key, false);
          return false;
        }
        current = next.toString();
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      forgejoHostCache.set(key, false);
      return false;
    }
    const body: unknown = await res.json();
    const ok =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { version?: unknown }).version === 'string' &&
      Boolean((body as { version: string }).version);
    forgejoHostCache.set(key, ok);
    return ok;
  } catch {
    forgejoHostCache.set(key, false);
    return false;
  }
}

function forgejoHeaders(hostname?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'gharchive',
  };
  // Only attach env tokens for known public hosts. Sending FORGEJO_TOKEN to
  // arbitrary self-hosted hostnames from user clone URLs would leak secrets.
  const host = hostname ? normalizeHostname(hostname) : '';
  if (host === 'codeberg.org') {
    const token =
      process.env.CODEBERG_TOKEN ||
      process.env.FORGEJO_TOKEN ||
      process.env.GITEA_TOKEN;
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }
  }
  return headers;
}

export async function fetchForgejoRepoMeta(
  hostname: string,
  owner: string,
  name: string,
  port?: string | null
): Promise<RemoteRepoMeta> {
  if (isUnsafeOutboundHostname(hostname)) {
    throw new Error('Forgejo host not allowed');
  }
  const base = forgejoApiBase(hostname, port);
  const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: forgejoHeaders(hostname),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (!res.ok) {
    throw new Error(`Forgejo API error: ${res.status}`);
  }
  const r = await res.json();

  const topics: string[] = Array.isArray(r.topics)
    ? r.topics.filter((t: unknown) => typeof t === 'string')
    : [];

  return {
    remote_description:
      typeof r.description === 'string' ? r.description : null,
    topics,
    language: typeof r.language === 'string' ? r.language : null,
    homepage:
      typeof r.website === 'string' && r.website ? r.website : null,
    stargazers_count:
      typeof r.stars_count === 'number' ? r.stars_count : null,
    forks_count: typeof r.forks_count === 'number' ? r.forks_count : null,
    license:
      r.license?.spdx_id ||
      r.license?.name ||
      (typeof r.license === 'string' ? r.license : null) ||
      null,
    is_private: Boolean(r.private),
    is_archived: Boolean(r.archived),
    is_fork: Boolean(r.fork),
    remote_updated_at:
      typeof r.updated_at === 'string'
        ? r.updated_at
        : typeof r.created_at === 'string'
          ? r.created_at
          : null,
  };
}

export async function fetchForgejoReleases(
  hostname: string,
  owner: string,
  name: string,
  port?: string | null
): Promise<ReleaseData[]> {
  if (isUnsafeOutboundHostname(hostname)) {
    throw new Error('Forgejo host not allowed');
  }
  const base = forgejoApiBase(hostname, port);
  // Forgejo paginates; request a large page. limit max is typically 50.
  const all: ReleaseData[] = [];
  let page = 1;
  const limit = 50;

  while (page <= 20) {
    const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?limit=${limit}&page=${page}`;
    const res = await fetch(url, {
      headers: forgejoHeaders(hostname),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!res.ok) {
      throw new Error(`Forgejo API error: ${res.status}`);
    }
    const batch: any[] = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const r of batch) {
      all.push({
        tag_name: r.tag_name,
        name: r.name || r.tag_name,
        body: r.body || '',
        published_at: r.published_at || r.created_at,
        assets: (r.assets || []).map((a: any) => ({
          name: a.name,
          content_type: a.content_type || a.type || 'application/octet-stream',
          size: typeof a.size === 'number' ? a.size : 0,
          download_url: a.browser_download_url || a.download_url || '',
        })),
      });
    }

    if (batch.length < limit) break;
    page++;
  }

  return all;
}

/**
 * Whether we should attempt Forgejo API for this host (known or detected).
 */
export async function resolveForgejoHost(
  hostname: string,
  port?: string | null
): Promise<boolean> {
  if (isKnownForgejoHost(hostname)) return true;
  return detectForgejoHost(hostname, port);
}
