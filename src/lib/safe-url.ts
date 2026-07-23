/**
 * Shared URL safety helpers: trusted download hosts, path confinement,
 * Content-Disposition sanitization, outbound-host SSRF guards.
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
  // Codeberg (Forgejo) + release downloads stay on the same host
  'codeberg.org',
  'www.codeberg.org',
]);

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** @deprecated use normalizeHostname */
function normalizeHost(hostname: string): string {
  return normalizeHostname(hostname);
}

/**
 * Hosts that must never be used for server-side outbound requests
 * (clone metadata probes, asset downloads, host approval).
 *
 * Blocks loopback, link-local / cloud-metadata, and well-known metadata names.
 * RFC1918 private ranges are allowed so self-hosted LAN forges still work when
 * the user explicitly adds them as a clone URL (extraHosts).
 */
export function isUnsafeOutboundHostname(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return true;
  let host = normalizeHostname(hostname);
  // Strip IPv6 brackets if present
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'kubernetes.default' ||
    host === 'kubernetes.default.svc' ||
    host === 'kubernetes.default.svc.cluster.local'
  ) {
    return true;
  }

  // IPv6 loopback / link-local / IPv4-mapped
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]*:/i.test(host)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4Mapped = host.match(/^(?:0:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4Mapped) {
    return isUnsafeIpv4(v4Mapped[1]!);
  }

  // Dotted IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return isUnsafeIpv4(host);
  }

  return false;
}

function isUnsafeIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8
  if (a === 0) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local + cloud metadata
  if (a === 169 && b === 254) return true;
  // 255.255.255.255 broadcast
  if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) return true;
  return false;
}

/** True when hostname is an exact trusted host or a githubusercontent subdomain. */
export function isTrustedAssetHost(
  hostname: string,
  extraHosts?: Iterable<string>
): boolean {
  const host = normalizeHost(hostname);
  // Never trust loopback / metadata even if listed in extraHosts
  if (isUnsafeOutboundHostname(host)) return false;
  if (TRUSTED_ASSET_HOSTS.has(host)) return true;
  // GitHub release CDN uses rotating subdomains
  if (host.endsWith('.githubusercontent.com')) return true;
  if (host.endsWith('.gitlab-static.net')) return true;
  if (extraHosts) {
    for (const h of extraHosts) {
      if (normalizeHost(h) === host) return true;
    }
  }
  return false;
}

/**
 * Validate an asset download URL scheme + host.
 * Returns the parsed URL or null if untrusted.
 * @param extraHosts Optional per-download host allowlist (e.g. the repo's forge host).
 */
export function parseTrustedAssetUrl(
  raw: string,
  extraHosts?: Iterable<string>
): URL | null {
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
  if (isUnsafeOutboundHostname(u.hostname)) return null;
  if (!isTrustedAssetHost(u.hostname, extraHosts)) return null;
  // Block credentials in URL
  if (u.username || u.password) return null;
  return u;
}

/**
 * Hosts that may receive a forge/platform auth token during asset download.
 * Never send tokens to user-approved or arbitrary extra hosts (credential theft).
 */
export function assetAuthForHostname(hostname: string): {
  header: string;
  value: string;
} | null {
  const host = normalizeHostname(hostname);
  if (isUnsafeOutboundHostname(host)) return null;

  if (
    host === 'github.com' ||
    host === 'api.github.com' ||
    host.endsWith('.githubusercontent.com')
  ) {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) return { header: 'Authorization', value: `Bearer ${token}` };
    return null;
  }

  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
    const token = process.env.GITLAB_TOKEN?.trim();
    if (token) return { header: 'PRIVATE-TOKEN', value: token };
    return null;
  }

  if (host === 'codeberg.org') {
    const token =
      process.env.CODEBERG_TOKEN?.trim() ||
      process.env.FORGEJO_TOKEN?.trim() ||
      process.env.GITEA_TOKEN?.trim();
    if (token) return { header: 'Authorization', value: `token ${token}` };
    return null;
  }

  return null;
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
