/**
 * Shared URL safety helpers: trusted download hosts, path confinement,
 * Content-Disposition sanitization.
 */

import path from 'path';
import fs from 'fs';

/** Hosts allowed for release-asset redirects and outbound downloads. */
const TRUSTED_ASSET_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'gitlab.com',
  'www.gitlab.com',
  'cdn.gitlab.com',
]);

/** True when hostname is an exact trusted host or a githubusercontent subdomain. */
export function isTrustedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (TRUSTED_ASSET_HOSTS.has(host)) return true;
  // GitHub release CDN uses rotating subdomains
  if (host.endsWith('.githubusercontent.com')) return true;
  if (host.endsWith('.gitlab-static.net')) return true;
  return false;
}

/**
 * Validate an asset download URL scheme + host.
 * Returns the parsed URL or null if untrusted.
 */
export function parseTrustedAssetUrl(raw: string): URL | null {
  if (!raw || typeof raw !== 'string' || raw.length > 4000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Prefer HTTPS in production; allow http only for localhost-style (never for assets)
  if (u.protocol === 'http:') return null;
  if (!isTrustedAssetHost(u.hostname)) return null;
  // Block credentials in URL
  if (u.username || u.password) return null;
  return u;
}

/**
 * Resolve `child` and ensure it stays under `parent` (after realpath when possible).
 * Prevents path traversal / symlink escape for local asset reads.
 */
export function isPathInside(parentDir: string, candidatePath: string): boolean {
  try {
    const parent = fs.existsSync(parentDir)
      ? fs.realpathSync(parentDir)
      : path.resolve(parentDir);
    // candidate may not exist yet — resolve without realpath first
    let candidate = path.resolve(candidatePath);
    if (fs.existsSync(candidate)) {
      try {
        candidate = fs.realpathSync(candidate);
      } catch {
        return false;
      }
    }
    const rel = path.relative(parent, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** DATA_DIR/releases root used for asset path confinement. */
export function getReleasesRoot(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(path.join(dataDir, 'releases'));
}

/**
 * RFC 5987-ish safe Content-Disposition filename.
 * Strips CR/LF/quotes/path separators that enable header injection.
 */
export function safeContentDispositionFilename(name: string): string {
  const base = path.basename(name || 'download').replace(/[\r\n"\\]/g, '');
  const cleaned = base.replace(/[^\x20-\x7E]/g, '_') || 'download';
  // Avoid empty or weird names
  return cleaned.slice(0, 200);
}

/**
 * Build a Content-Disposition header value.
 */
export function contentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment'
): string {
  const safe = safeContentDispositionFilename(filename);
  // ASCII fallback + UTF-8 filename* for non-ascii originals
  return `${type}; filename="${safe}"`;
}
