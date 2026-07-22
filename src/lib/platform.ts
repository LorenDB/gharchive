const PLATFORM_DISPLAY: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
};

const PLATFORM_URL_BASE: Record<string, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

export function platformDisplay(platform: string | null | undefined): string {
  if (!platform) return 'Remote';
  return (
    PLATFORM_DISPLAY[platform] ??
    platform.charAt(0).toUpperCase() + platform.slice(1)
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
  if (!base) return null;
  return `${base}/${owner}/${name}`;
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
