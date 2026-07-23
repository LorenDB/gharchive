/**
 * User-approved / rejected download hosts for release assets.
 *
 * Built-in CDNs (GitHub, GitLab, Codeberg) and the repo's own clone host are
 * always trusted. Forgejo (and others) sometimes serve assets from a different
 * domain — those require explicit user approval before we fetch them.
 */

import fs from 'fs';
import {
  getSettings,
  updateSettings,
  getDb,
  getArchiveById,
  updateReleaseAsset,
  listPendingAssetHostsForUser,
  upsertPendingAssetHost,
  removePendingAssetHost,
  getAllReleaseAssets,
  resolveReleaseAssetPolicy,
  getArchiveReleasesSorted,
  shouldCacheReleaseAtIndex,
  type PendingAssetHostApproval,
} from '@/lib/db';
import { isTrustedAssetHost, parseTrustedAssetUrl } from '@/lib/safe-url';
import {
  downloadReleaseAsset,
  getReleaseAssetPath,
} from '@/lib/releases';
import { resolveExistingAssetFile } from '@/lib/asset-compression';
import { hostInfoFromCloneUrl } from '@/lib/forgejo';
import { tryGetUserId, AUTOLOGIN_USER_ID } from '@/lib/user-context';

export type AssetHostDecision = 'trusted' | 'approved' | 'rejected' | 'unknown';

/** Validate and normalize a hostname for storage / comparison. */
export function normalizeAssetHostname(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const host = raw
    .toLowerCase()
    .trim()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!host || host.length > 253) return null;
  // Hostname labels (no scheme, path, or userinfo)
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
  if (host.includes('..')) return null;
  return host;
}

/** Extract https hostname from a download URL, or null. */
export function hostnameFromAssetUrl(
  url: string | null | undefined
): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return normalizeAssetHostname(u.hostname);
  } catch {
    return null;
  }
}

/**
 * Classify a download host relative to built-ins, the repo host, and
 * the current user's approved/rejected lists.
 */
export function classifyAssetHost(
  hostname: string,
  extraHosts: Iterable<string> = [],
  settings?: { approved_asset_hosts?: string[]; rejected_asset_hosts?: string[] }
): AssetHostDecision {
  const host = normalizeAssetHostname(hostname);
  if (!host) return 'unknown';

  const s = settings ?? getSettings();
  const approved = new Set(
    (s.approved_asset_hosts || [])
      .map(normalizeAssetHostname)
      .filter((h): h is string => Boolean(h))
  );
  const rejected = new Set(
    (s.rejected_asset_hosts || [])
      .map(normalizeAssetHostname)
      .filter((h): h is string => Boolean(h))
  );

  if (rejected.has(host)) return 'rejected';
  if (isTrustedAssetHost(host, extraHosts)) return 'trusted';
  if (approved.has(host)) return 'approved';
  return 'unknown';
}

/** Hostnames that may be passed to parseTrustedAssetUrl / downloadReleaseAsset. */
export function effectiveExtraTrustedHosts(
  repoCloneUrl: string | null | undefined,
  settings?: { approved_asset_hosts?: string[] }
): string[] {
  const hosts: string[] = [];
  const hi = hostInfoFromCloneUrl(repoCloneUrl ?? null);
  if (hi?.hostname) hosts.push(hi.hostname);

  const s = settings ?? getSettings();
  for (const h of s.approved_asset_hosts || []) {
    const n = normalizeAssetHostname(h);
    if (n) hosts.push(n);
  }
  return hosts;
}

// ── Pending / decisions ─────────────────────────────────────────

export function listAssetHostDecisions(): {
  pending: PendingAssetHostApproval[];
  approved: string[];
  rejected: string[];
} {
  const settings = getSettings();
  return {
    pending: listPendingAssetHostsForUser(),
    approved: [...(settings.approved_asset_hosts || [])],
    rejected: [...(settings.rejected_asset_hosts || [])],
  };
}

/**
 * Record that sync saw an asset on an untrusted host.
 * No-ops if already approved, rejected, or already pending.
 */
export function requestAssetHostApproval(input: {
  hostname: string;
  sample_url: string;
  repo_label: string;
}): boolean {
  const host = normalizeAssetHostname(input.hostname);
  if (!host) return false;

  const decision = classifyAssetHost(host);
  if (
    decision === 'trusted' ||
    decision === 'approved' ||
    decision === 'rejected'
  ) {
    return false;
  }

  return upsertPendingAssetHost({
    hostname: host,
    sample_url: input.sample_url.slice(0, 500),
    repo_label: input.repo_label.slice(0, 200),
    first_seen_at: new Date().toISOString(),
  });
}

export type AssetHostActionResult = {
  hostname: string;
  action: 'approve' | 'reject' | 'revoke';
  approved: string[];
  rejected: string[];
  pending: PendingAssetHostApproval[];
  downloaded?: number;
};

/**
 * Approve a host for asset downloads, clear pending, and try to fetch
 * any archived assets that were waiting on this domain.
 */
export async function approveAssetHost(
  hostname: string
): Promise<AssetHostActionResult> {
  const host = normalizeAssetHostname(hostname);
  if (!host) throw new Error('Invalid hostname');

  const settings = getSettings();
  const approved = uniqueHosts([...(settings.approved_asset_hosts || []), host]);
  const rejected = (settings.rejected_asset_hosts || []).filter(
    (h) => normalizeAssetHostname(h) !== host
  );

  updateSettings({
    approved_asset_hosts: approved,
    rejected_asset_hosts: rejected,
  });
  removePendingAssetHost(host);

  const downloaded = await downloadMissingAssetsFromHost(host);

  return {
    hostname: host,
    action: 'approve',
    approved,
    rejected,
    pending: listPendingAssetHostsForUser(),
    downloaded,
  };
}

/** Reject a host — never download assets from it (until revoked). */
export function rejectAssetHost(hostname: string): AssetHostActionResult {
  const host = normalizeAssetHostname(hostname);
  if (!host) throw new Error('Invalid hostname');

  const settings = getSettings();
  const rejected = uniqueHosts([
    ...(settings.rejected_asset_hosts || []),
    host,
  ]);
  const approved = (settings.approved_asset_hosts || []).filter(
    (h) => normalizeAssetHostname(h) !== host
  );

  updateSettings({
    approved_asset_hosts: approved,
    rejected_asset_hosts: rejected,
  });
  removePendingAssetHost(host);

  return {
    hostname: host,
    action: 'reject',
    approved,
    rejected,
    pending: listPendingAssetHostsForUser(),
  };
}

/** Remove a host from both approved and rejected lists. */
export function revokeAssetHostDecision(
  hostname: string
): AssetHostActionResult {
  const host = normalizeAssetHostname(hostname);
  if (!host) throw new Error('Invalid hostname');

  const settings = getSettings();
  const approved = (settings.approved_asset_hosts || []).filter(
    (h) => normalizeAssetHostname(h) !== host
  );
  const rejected = (settings.rejected_asset_hosts || []).filter(
    (h) => normalizeAssetHostname(h) !== host
  );

  updateSettings({
    approved_asset_hosts: approved,
    rejected_asset_hosts: rejected,
  });

  return {
    hostname: host,
    action: 'revoke',
    approved,
    rejected,
    pending: listPendingAssetHostsForUser(),
  };
}

function uniqueHosts(hosts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hosts) {
    const n = normalizeAssetHostname(h);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Download release assets whose download_url is on `hostname` and that
 * are not yet local, for archives the current user is a member of.
 */
export async function downloadMissingAssetsFromHost(
  hostname: string
): Promise<number> {
  const host = normalizeAssetHostname(hostname);
  if (!host) return 0;

  const settings = getSettings();
  if (settings.release_asset_mode === 'none' || !settings.download_release_assets) {
    return 0;
  }

  const userId = tryGetUserId() ?? AUTOLOGIN_USER_ID;
  const db = getDb();
  const userRepos = db.repos;
  const userArchiveIds = new Set(userRepos.map((r) => r.archive_id));
  const releaseById = new Map(db.releases.map((r) => [r.id, r]));
  // Prefer user-scoped assets from getDb; fall back to global for safety
  const assets =
    db.releaseAssets.length > 0 ? db.releaseAssets : getAllReleaseAssets();

  // Per-archive: which release ids this user would cache under their policy.
  // Missing entry = no membership; 'all' = every release; Set = explicit allow-list.
  const cacheableByArchive = new Map<number, 'all' | Set<number>>();
  for (const membership of userRepos) {
    const policy = resolveReleaseAssetPolicy(settings, membership);
    if (policy.mode === 'none') {
      cacheableByArchive.set(membership.archive_id, new Set());
      continue;
    }
    if (policy.mode === 'all') {
      cacheableByArchive.set(membership.archive_id, 'all');
      continue;
    }
    const sorted = getArchiveReleasesSorted(membership.archive_id);
    const keep = new Set<number>();
    sorted.forEach((r, i) => {
      if (shouldCacheReleaseAtIndex(policy, i)) keep.add(r.id);
    });
    cacheableByArchive.set(membership.archive_id, keep);
  }

  let downloaded = 0;
  const maxBytes =
    settings.max_asset_size_mb > 0
      ? settings.max_asset_size_mb * 1024 * 1024
      : Infinity;

  for (const asset of assets) {
    if (asset.file_path && fs.existsSync(asset.file_path)) continue;
    if (!asset.download_url) continue;
    if (hostnameFromAssetUrl(asset.download_url) !== host) continue;

    const release = releaseById.get(asset.release_id);
    if (!release || !userArchiveIds.has(release.archive_id)) continue;

    const keep = cacheableByArchive.get(release.archive_id);
    if (keep === undefined) continue;
    if (keep !== 'all' && !keep.has(release.id)) continue;

    const archive = getArchiveById(release.archive_id);
    if (!archive) continue;

    const extra = effectiveExtraTrustedHosts(archive.clone_url, settings);
    if (classifyAssetHost(host, extra, settings) === 'rejected') continue;
    if (!parseTrustedAssetUrl(asset.download_url, extra)) continue;

    if (asset.size && asset.size > 0 && asset.size > maxBytes) continue;

    const dest = getReleaseAssetPath(
      archive.platform,
      archive.owner,
      archive.name,
      release.tag_name,
      asset.name,
      { isPrivate: Boolean(archive.is_private), userId }
    );

    const existingFile = resolveExistingAssetFile(dest);
    if (existingFile) {
      updateReleaseAsset(asset.id, {
        file_path: existingFile.path,
        storage_compressed: existingFile.storageCompressed,
      });
      downloaded++;
      continue;
    }

    const result = await downloadReleaseAsset(asset.download_url, dest, {
      extraTrustedHosts: extra,
      compress: settings.compress_release_assets,
      assetName: asset.name,
    });
    if (result.ok) {
      updateReleaseAsset(asset.id, {
        file_path: result.filePath || dest,
        storage_compressed: Boolean(result.storageCompressed),
      });
      downloaded++;
    }
  }

  return downloaded;
}
