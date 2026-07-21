/**
 * Resolve relative asset URLs inside a README against the archived mirror.
 */

/** True for absolute / special schemes that should not be rewritten. */
export function isAbsoluteOrSpecialUrl(href: string): boolean {
  if (!href) return true;
  const t = href.trim();
  if (!t) return true;
  if (/^(https?:|data:|blob:|cid:|mailto:|javascript:)/i.test(t)) return true;
  if (t.startsWith('//')) return true;
  if (t.startsWith('#')) return true;
  return false;
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
 * when relative; leave absolute URLs unchanged.
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
  if (isAbsoluteOrSpecialUrl(src)) return src;

  const repoPath = resolveRepoAssetPath(opts.readmeDir, src);
  if (!repoPath) return src;

  return mirrorAssetUrl(opts.repoId, opts.ref, repoPath);
}
