/**
 * Resolve relative asset URLs inside a README against the archived mirror.
 * Also extracts absolute http(s) URLs for optional Wayback Machine archival.
 */

/** True for absolute / special schemes that should not be rewritten. */
export function isAbsoluteOrSpecialUrl(href: string): boolean {
  if (!href) return true;
  const t = href.trim();
  if (!t) return true;
  if (/^(https?:|data:|blob:|cid:|mailto:|javascript:|vbscript:)/i.test(t)) return true;
  if (t.startsWith('//')) return true;
  if (t.startsWith('#')) return true;
  return false;
}

/**
 * Normalize a candidate URL for Wayback submission.
 * Returns null if not a plain absolute http(s) URL worth archiving.
 */
export function normalizeAbsoluteHttpUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // Strip common trailing punctuation from bare-URL extraction
  s = s.replace(/[),.;:!?'"\]]+$/g, '');
  // Angle-bracket autolinks
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }

  // Protocol-relative → https
  if (s.startsWith('//')) {
    s = 'https:' + s;
  }

  if (!/^https?:\/\//i.test(s)) return null;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Skip credentials-in-URL and empty host
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  // Block loopback / metadata / link-local and RFC1918: submitting LAN URLs
  // to the public Wayback Machine leaks internal hostnames and is never useful.
  // (Inline to avoid a safe-url import cycle; keep in sync with
  // isUnsafeOutboundHostname plus RFC1918.)
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host === 'kubernetes.default' ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  // Cap length (SPN2 / practical)
  if (u.href.length > 2000) return null;

  // Prefer https href string without hash (fragment not fetched by crawlers)
  u.hash = '';
  return u.href;
}

/**
 * Extract unique absolute http(s) URLs from README markdown / plain / HTML.
 * Covers markdown links/images, angle autolinks, HTML href/src, and bare URLs.
 */
export function extractAbsoluteUrls(content: string): string[] {
  if (!content || typeof content !== 'string') return [];

  const found = new Set<string>();

  const add = (raw: string) => {
    const n = normalizeAbsoluteHttpUrl(raw);
    if (n) found.add(n);
  };

  // Markdown images/links: ![alt](url) or [text](url) — optional angle brackets
  // Also title: [text](url "title")
  const mdLinkRe =
    /!\[[^\]]*]\(\s*<?([^>\s)]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[[^\]]*]\(\s*<?([^>\s)]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(content)) !== null) {
    add(m[1] || m[2] || '');
  }

  // Angle-bracket autolinks: <https://example.com>
  const angleRe = /<(https?:\/\/[^>\s]+)>/gi;
  while ((m = angleRe.exec(content)) !== null) {
    add(m[1]);
  }

  // HTML href / src attributes (double or single quotes)
  const attrRe = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = attrRe.exec(content)) !== null) {
    add(m[1] || m[2] || '');
  }

  // Bare http(s) URLs not already captured (conservative character class)
  const bareRe = /https?:\/\/[^\s<>"'`)\]]+/gi;
  while ((m = bareRe.exec(content)) !== null) {
    add(m[0]);
  }

  return [...found];
}

/**
 * Normalize a path relative to the README's directory within the repo.
 * Returns null if the path escapes the repo root or is not a repo path.
 */
export function resolveRepoAssetPath(
  readmeDir: string,
  href: string
): string | null {
  if (isAbsoluteOrSpecialUrl(href)) return null;

  let path = href.trim().split('#')[0].split('?')[0];
  if (!path) return null;

  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }

  const segments: string[] = [];
  if (path.startsWith('/')) {
    for (const p of path.slice(1).split('/')) {
      if (p === '' || p === '.') continue;
      if (p === '..') return null;
      segments.push(p);
    }
  } else {
    for (const p of [
      ...readmeDir.split('/').filter(Boolean),
      ...path.split('/'),
    ]) {
      if (p === '' || p === '.') continue;
      if (p === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else {
        segments.push(p);
      }
    }
  }

  if (segments.length === 0) return null;
  return segments.join('/');
}

/** Directory containing the README (empty string = repo root). */
export function readmeDirFromPath(readmePath: string | null | undefined): string {
  if (!readmePath) return '';
  const idx = readmePath.lastIndexOf('/');
  if (idx < 0) return '';
  return readmePath.slice(0, idx);
}

/**
 * Build a URL that serves a file from the local mirror.
 * Relative image srcs should be rewritten to this.
 */
export function mirrorAssetUrl(
  repoId: string | number,
  ref: string,
  repoPath: string
): string {
  const params = new URLSearchParams({ path: repoPath });
  if (ref) params.set('ref', ref);
  return `/api/repos/${repoId}/raw?${params.toString()}`;
}

/**
 * Rewrite a README asset URL (img src, etc.) to the mirror raw endpoint
 * when relative; leave absolute URLs unchanged. Dangerous schemes
 * (javascript:/data:/vbscript:) are neutralized to '#' so they can never
 * become clickable/executable even if sanitization is bypassed.
 */
export function rewriteReadmeAssetUrl(
  src: string | undefined | null,
  opts: {
    repoId: string | number;
    ref: string;
    readmeDir: string;
  }
): string | undefined {
  if (src == null || src === '') return src ?? undefined;
  const t = src.trim();
  if (/^(javascript|vbscript|data|blob):/i.test(t)) return '#';
  if (isAbsoluteOrSpecialUrl(src)) return src;

  const repoPath = resolveRepoAssetPath(opts.readmeDir, src);
  if (!repoPath) return src;

  return mirrorAssetUrl(opts.repoId, opts.ref, repoPath);
}
