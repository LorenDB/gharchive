const PLATFORM_DISPLAY: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
};

const PLATFORM_URL_BASE: Record<string, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  codeberg: 'https://codeberg.org',
};

/** Canonical platform id → default public hostname */
const PLATFORM_HOST: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  codeberg: 'codeberg.org',
};

/** Hostname (lowercased) → platform id used on disk / in db */
const HOST_TO_PLATFORM: Record<string, string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'codeberg',
};

export type RemoteApiKind = 'github' | 'gitlab' | 'forgejo' | 'none';

/** Platform ids that always have a known rich API (no probe needed). */
const PLATFORM_API_KIND: Record<string, RemoteApiKind> = {
  github: 'github',
  gitlab: 'gitlab',
  codeberg: 'forgejo',
};

export function platformDisplay(platform: string | null | undefined): string {
  if (!platform) return 'Remote';
  return (
    PLATFORM_DISPLAY[platform] ??
    // Hostnames-as-platform: show as-is (e.g. git.example.com)
    (platform.includes('.')
      ? platform
      : platform.charAt(0).toUpperCase() + platform.slice(1))
  );
}

/**
 * Build a browser URL for a repo from platform + owner/name.
 * Prefer {@link remoteWebUrl} when a clone URL is available — it preserves
 * nested GitLab group paths and the real host.
 */
export function platformUrl(
  platform: string | null | undefined,
  owner: string,
  name: string
): string | null {
  if (!platform) return null;
  const base = PLATFORM_URL_BASE[platform];
  if (base) return `${base}/${owner}/${name}`;
  // Arbitrary host stored as platform id (e.g. git.example.com)
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(platform) && platform.includes('.')) {
    return `https://${platform}/${owner}/${name}`;
  }
  return null;
}

/**
 * Convert a clone URL (https or SSH) into the corresponding web UI URL.
 * Strips a trailing `.git` and maps `git@host:path` → `https://host/path`.
 */
export function remoteWebUrl(cloneUrl: string | null | undefined): string | null {
  if (!cloneUrl || typeof cloneUrl !== 'string') return null;
  const cleaned = cloneUrl.trim();
  if (!cleaned) return null;

  const ssh = cleaned.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    const host = ssh[1];
    const path = ssh[2].replace(/\.git$/, '').replace(/\/$/, '');
    if (!host || !path) return null;
    return `https://${host}/${path}`;
  }

  if (/^https?:\/\//i.test(cleaned)) {
    return cleaned.replace(/\.git$/, '').replace(/\/$/, '');
  }

  return null;
}

/** Preferred remote web link: clone URL first, then platform + owner/name. */
export function repoRemoteUrl(repo: {
  platform?: string | null;
  owner: string;
  name: string;
  clone_url?: string | null;
}): string | null {
  return (
    remoteWebUrl(repo.clone_url) ??
    platformUrl(repo.platform, repo.owner, repo.name)
  );
}

export function isGithub(platform: string | null | undefined): boolean {
  return platform === 'github';
}

/** Map a git host to the platform id used for on-disk paths and dedup. */
export function platformFromHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return HOST_TO_PLATFORM[host] ?? host;
}

/** Default public hostname for a known platform id (null if unknown). */
export function hostForPlatform(platform: string): string | null {
  if (PLATFORM_HOST[platform]) return PLATFORM_HOST[platform];
  // Host-as-platform for arbitrary imports
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(platform)) return platform;
  return null;
}

/** Known rich-API kind for a platform id (without network probe). */
export function knownApiKind(platform: string): RemoteApiKind {
  return PLATFORM_API_KIND[platform] ?? 'none';
}

/**
 * Build a default https clone URL when only platform + owner/name are known.
 */
export function defaultCloneUrl(
  platform: string,
  owner: string,
  name: string
): string {
  const host = hostForPlatform(platform) ?? 'github.com';
  return `https://${host}/${owner}/${name}.git`;
}
