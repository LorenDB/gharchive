import fs from 'fs';
import {
  addRelease,
  addReleaseAsset,
  addSyncLog,
  updateRepo,
  tagExists as dbTagExists,
  getReleaseByTag,
  getSettings,
  getDb,
  countArchiveReleases,
  findReleaseAsset,
  updateReleaseAsset,
  resolveReleaseAssetPolicy,
  getArchiveReleaseAssetPolicy,
  getArchiveReleasesSorted,
  shouldCacheReleaseAtIndex,
  pruneReleaseAssets,
  type ReleaseAssetMode,
} from '@/lib/db';
import { syncMirror, isRemoteMissingError, withMirrorLock } from '@/lib/git';
import {
  fetchReleases,
  downloadReleaseAsset,
  getReleaseAssetPath,
} from '@/lib/releases';
import { checkRemoteRepoExists } from '@/lib/remote-exists';
import { knownApiKind } from '@/lib/platform';
import { fetchRemoteRepoMeta } from '@/lib/remote-meta';
import { hasEnoughMemory } from '@/lib/memory';
import { sendAlert, repoLabel } from '@/lib/alerts';
import {
  classifyAssetHost,
  effectiveExtraTrustedHosts,
  hostnameFromAssetUrl,
  requestAssetHostApproval,
} from '@/lib/asset-hosts';
import {
  archiveReadmeUrlsFromMirror,
  hasWaybackCredentials,
  waybackCredentialsFromSettings,
} from '@/lib/wayback';

export interface RepoLike {
  id: number;
  archive_id: number;
  platform: string;
  owner: string;
  name: string;
  mirror_path: string;
  clone_url?: string;
  is_private?: boolean;
  release_asset_mode?: ReleaseAssetMode | null;
  release_asset_keep_last?: number | null;
}

/**
 * Full sync: snapshot+fetch git mirror, then pull releases/assets.
 * When `skipGit` is true (fresh clone), only release metadata/assets are synced.
 * Content is stored on the shared archive; sync_logs attach to the membership id.
 * Emits Apprise alerts for major archive events when configured.
 */
export async function syncRepo(
  repo: RepoLike,
  options: { skipGit?: boolean; onProgress?: (detail: string) => void } = {}
): Promise<{ ok: boolean; messages: string[]; error?: string }> {
  const messages: string[] = [];
  const settings = getSettings();
  const label = repoLabel(repo);
  const archiveId = repo.archive_id;
  const isPrivate = Boolean(repo.is_private);

  if (!options.skipGit) {
    const memCheck = hasEnoughMemory();
    if (!memCheck.ok) {
      addSyncLog({
        repo_id: repo.id,
        status: 'failed',
        message: `sync deferred (low memory): ${memCheck.reason}`,
      });
      return { ok: false, messages, error: `Low memory: ${memCheck.reason}` };
    }

    const apiKind = knownApiKind(repo.platform);
    if (apiKind !== 'none') {
      const existsResult = await checkRemoteRepoExists(
        repo.platform,
        repo.owner,
        repo.name,
        { cloneUrl: repo.clone_url }
      );
      if (existsResult.exists === false) {
        messages.push(
          `remote: repository not found via ${apiKind} API (${existsResult.statusCode})`
        );
        addSyncLog({
          repo_id: repo.id,
          status: 'failed',
          message: messages.join('; '),
        });
        await sendAlert({
          category: 'repo_deleted',
          title: `Repo deleted: ${label}`,
          body: [
            `**${label}** appears to be gone or inaccessible on the remote.`,
            '',
            `The ${apiKind} API returned ${existsResult.statusCode}.`,
            '',
            'The local bare mirror and archived releases are still kept.',
          ].join('\n'),
          subject: `archive:${archiveId}`,
          severity: 'failure',
        });
        updateRepo(repo.id, { remote_deleted_at: new Date().toISOString() });
        return { ok: false, messages, error: 'Remote repository not found' };
      }
    }

    try {
      const gitResult = await withMirrorLock(repo.mirror_path, () =>
        syncMirror(repo.mirror_path)
      );
      messages.push(`git: ${gitResult.message || 'up to date'}`);

      if (gitResult.repoDeleted) {
        messages.push('remote: repository appears deleted/inaccessible');
        addSyncLog({
          repo_id: repo.id,
          status: 'failed',
          message: messages.join('; '),
        });
        await sendAlert({
          category: 'repo_deleted',
          title: `Repo deleted: ${label}`,
          body: [
            `**${label}** appears to be gone or inaccessible on the remote.`,
            '',
            'The local bare mirror and archived releases are still kept.',
            '',
            '```',
            gitResult.message.slice(0, 500),
            '```',
          ].join('\n'),
          subject: `archive:${archiveId}`,
          severity: 'failure',
        });
        updateRepo(repo.id, { remote_deleted_at: new Date().toISOString() });
        return { ok: false, messages, error: 'Remote repository not found' };
      }

      if (gitResult.historyWiped) {
        messages.push(`history wipe: ${gitResult.historyDetails.join('; ')}`);
        await sendAlert({
          category: 'history_wiped',
          title: `History wiped: ${label}`,
          body: [
            `**${label}** git history changed in a destructive way upstream.`,
            'Pre-fetch tips were snapshotted under `refs/archive/` in the bare mirror.',
            '',
            ...gitResult.historyDetails.map((d) => `- ${d}`),
          ].join('\n'),
          subject: `archive:${archiveId}:${gitResult.historyDetails[0] || 'wipe'}`,
          severity: 'failure',
        });
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const combined = `${err?.stderr || ''}\n${errMsg}`;

      if (isRemoteMissingError(combined)) {
        messages.push(`git: remote missing — ${errMsg}`);
        addSyncLog({
          repo_id: repo.id,
          status: 'failed',
          message: messages.join('; '),
        });
        await sendAlert({
          category: 'repo_deleted',
          title: `Repo deleted: ${label}`,
          body: [
            `**${label}** appears to be gone or inaccessible on the remote.`,
            '',
            '```',
            errMsg.slice(0, 500),
            '```',
          ].join('\n'),
          subject: `archive:${archiveId}`,
          severity: 'failure',
        });
        updateRepo(repo.id, { remote_deleted_at: new Date().toISOString() });
        return { ok: false, messages, error: errMsg };
      }

      addSyncLog({
        repo_id: repo.id,
        status: 'failed',
        message: `git sync failed: ${errMsg}`,
      });
      await sendAlert({
        category: 'sync_failed',
        title: `Sync failed: ${label}`,
        body: `Git sync failed for **${label}**:\n\n\`\`\`\n${errMsg.slice(0, 800)}\n\`\`\``,
        subject: `archive:${archiveId}:git`,
        severity: 'warning',
      });
      return { ok: false, messages, error: errMsg };
    }
  } else {
    messages.push('git: initial clone');
  }

  // Scrape remote description / topics / stars / archived (best-effort).
  // Known platforms (GitHub/GitLab/Codeberg) always try; arbitrary hosts probe
  // for a Forgejo/Gitea API and skip gracefully when none is found.
  try {
    const prior = getDb().repos.find((r) => r.id === repo.id);
    const wasArchived = Boolean(prior?.is_archived);
    const hadRemoteMeta = Boolean(prior?.remote_meta_synced_at);

    const meta = await fetchRemoteRepoMeta(repo.platform, repo.owner, repo.name, {
      cloneUrl: repo.clone_url,
    });
    if (meta) {
      updateRepo(repo.id, {
        ...meta,
        remote_meta_synced_at: new Date().toISOString(),
      });
      messages.push(
        meta.is_archived
          ? 'meta: refreshed (upstream archived)'
          : 'meta: remote description/topics refreshed'
      );

      if (meta.is_archived && !wasArchived && hadRemoteMeta) {
        messages.push('remote: repository marked archived upstream');
        await sendAlert({
          category: 'repo_archived',
          title: `Repo archived: ${label}`,
          body: [
            `**${label}** was marked as **archived** on the remote.`,
            '',
            'The local bare mirror and release archive are still kept.',
            'No new commits or releases are expected from upstream.',
          ].join('\n'),
          subject: `archive:${archiveId}:archived`,
          severity: 'warning',
        });
      }
    } else {
      messages.push('meta: unavailable');
    }
  } catch (err: any) {
    messages.push(`meta: failed - ${err?.message || err}`);
  }

  const priorReleaseCount = countArchiveReleases(archiveId);
  const newReleaseTags: string[] = [];

  // Built-in CDNs + repo host + user-approved hosts.
  const assetExtraHosts = effectiveExtraTrustedHosts(repo.clone_url, settings);

  try {
    const projectPath = `${repo.owner}/${repo.name}`;
    const releases = await fetchReleases(repo.platform, projectPath, {
      cloneUrl: repo.clone_url,
    });

    // null = no remote releases API (arbitrary plain-git host) — skip cleanly
    if (releases === null) {
      messages.push('releases: skipped (no remote API for this host)');
    } else {
      if (priorReleaseCount > 0 && releases.length === 0) {
        messages.push(
          `releases: wiped upstream (had ${priorReleaseCount} archived, remote has 0)`
        );
        await sendAlert({
          category: 'releases_wiped',
          title: `Releases wiped: ${label}`,
          body: [
            `**${label}** no longer has any releases on the remote.`,
            `Local archive still has **${priorReleaseCount}** release(s) (metadata/assets preserved).`,
          ].join('\n'),
          subject: `archive:${archiveId}`,
          severity: 'failure',
        });
      }

      let newReleases = 0;
      let newAssets = 0;
      let skippedAssets = 0;
      let awaitingHostApproval = 0;
      const pendingHosts = new Set<string>();
      const maxBytes =
        settings.max_asset_size_mb > 0
          ? settings.max_asset_size_mb * 1024 * 1024
          : Infinity;

      const downloadPolicy = resolveReleaseAssetPolicy(settings, repo);

      options.onProgress?.(`Fetching ${releases.length} releases...`);

      // Pass 1: upsert release metadata for every remote release
      for (const rel of releases) {
        if (!dbTagExists(archiveId, rel.tag_name)) {
          addRelease({
            archive_id: archiveId,
            tag_name: rel.tag_name,
            name: rel.name,
            body: rel.body,
            published_at: rel.published_at,
          });
          newReleases++;
          newReleaseTags.push(rel.tag_name);
        }
      }

      // Which releases should have assets cached for this user's download policy
      // (0 = newest). Archive-wide prune later uses the most-permissive member policy.
      const sortedLocal = getArchiveReleasesSorted(archiveId);
      const cacheableReleaseIds = new Set<number>();
      sortedLocal.forEach((r, i) => {
        if (shouldCacheReleaseAtIndex(downloadPolicy, i)) {
          cacheableReleaseIds.add(r.id);
        }
      });

      let releaseIdx = 0;
      for (const rel of releases) {
        releaseIdx++;
        options.onProgress?.(
          `Downloading release ${releaseIdx}/${releases.length}`
        );

        const releaseRow = getReleaseByTag(archiveId, rel.tag_name);
        if (!releaseRow) continue;

        const shouldCacheAssets = cacheableReleaseIds.has(releaseRow.id);

        for (const asset of rel.assets) {
          const existing = findReleaseAsset(releaseRow.id, asset.name);
          // Already local — skip
          if (
            existing?.file_path &&
            fs.existsSync(existing.file_path)
          ) {
            continue;
          }

          const assetPath = getReleaseAssetPath(
            repo.platform,
            repo.owner,
            repo.name,
            rel.tag_name,
            asset.name,
            { isPrivate }
          );

          let downloaded = false;
          const tooLarge = asset.size > 0 && asset.size > maxBytes;
          let skipReason:
            | 'settings'
            | 'policy'
            | 'size'
            | 'host'
            | 'rejected'
            | null = null;

          if (!shouldCacheAssets) {
            skipReason = 'policy';
            skippedAssets++;
          } else if (tooLarge) {
            skipReason = 'size';
            skippedAssets++;
          } else if (asset.download_url) {
            const assetHost = hostnameFromAssetUrl(asset.download_url);
            if (assetHost) {
              const decision = classifyAssetHost(
                assetHost,
                assetExtraHosts,
                settings
              );
              if (decision === 'rejected') {
                skipReason = 'rejected';
                skippedAssets++;
              } else if (decision === 'unknown') {
                requestAssetHostApproval({
                  hostname: assetHost,
                  sample_url: asset.download_url,
                  repo_label: label,
                });
                pendingHosts.add(assetHost);
                awaitingHostApproval++;
                skipReason = 'host';
              }
            }

            if (!skipReason) {
              if (asset.size > 10 * 1024 * 1024) {
                const assetMemCheck = hasEnoughMemory(
                  Math.ceil(asset.size / 1024 / 1024) +
                    settings.min_free_memory_mb
                );
                if (!assetMemCheck.ok) {
                  skippedAssets++;
                  skipReason = 'size';
                }
              }
            }

            if (!skipReason) {
              // Shared path from another user's sync
              if (fs.existsSync(assetPath)) {
                downloaded = true;
              } else {
                downloaded = await downloadReleaseAsset(
                  asset.download_url,
                  assetPath,
                  {
                    extraTrustedHosts: assetExtraHosts,
                    onUntrustedHost: (hostname, sampleUrl) => {
                      requestAssetHostApproval({
                        hostname,
                        sample_url: sampleUrl,
                        repo_label: label,
                      });
                      pendingHosts.add(hostname);
                      awaitingHostApproval++;
                    },
                  }
                );
              }
            }
          }

          if (existing) {
            if (downloaded) {
              updateReleaseAsset(existing.id, {
                file_path: assetPath,
                size: asset.size || existing.size,
                download_url: asset.download_url || existing.download_url,
              });
              newAssets++;
            }
          } else {
            addReleaseAsset({
              release_id: releaseRow.id,
              name: asset.name,
              content_type: asset.content_type,
              size: asset.size || null,
              file_path: downloaded ? assetPath : null,
              download_url: asset.download_url || null,
            });
            if (downloaded) newAssets++;
          }
        }
      }

      // Drop assets outside the most-permissive policy of any archive member
      const prunePolicy = getArchiveReleaseAssetPolicy(archiveId);
      const pruned = pruneReleaseAssets(archiveId, prunePolicy);

      let releaseMsg = `releases: ${releases.length} fetched (${newReleases} new, ${newAssets} assets)`;
      if (skippedAssets > 0) releaseMsg += `, ${skippedAssets} skipped`;
      if (pruned > 0) releaseMsg += `, ${pruned} pruned`;
      if (downloadPolicy.mode === 'last_n') {
        releaseMsg += ` [keep last ${downloadPolicy.keep_last}]`;
      } else if (downloadPolicy.mode === 'none') {
        releaseMsg += ' [assets off]';
      }
      if (awaitingHostApproval > 0) {
        releaseMsg += `, ${awaitingHostApproval} awaiting domain approval (${[...pendingHosts].join(', ')})`;
      }
      messages.push(releaseMsg);

      if (newReleaseTags.length > 0) {
        const tagList = newReleaseTags
          .slice(0, 20)
          .map((t) => `- \`${t}\``)
          .join('\n');
        const more =
          newReleaseTags.length > 20
            ? `\n…and ${newReleaseTags.length - 20} more`
            : '';
        await sendAlert({
          category: 'new_release',
          title:
            newReleaseTags.length === 1
              ? `New release: ${label} ${newReleaseTags[0]}`
              : `New releases: ${label} (${newReleaseTags.length})`,
          body: [
            `**${label}** has ${newReleaseTags.length} new release(s):`,
            '',
            tagList + more,
          ].join('\n'),
          subject: `archive:${archiveId}:${newReleaseTags.join(',')}`,
          severity: 'info',
        });
      }
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    messages.push(`releases: failed - ${errMsg}`);

    if (
      isRemoteMissingError(errMsg) ||
      /GitHub API error: 404/i.test(errMsg) ||
      /GitLab API error: 404/i.test(errMsg) ||
      /Forgejo API error: 404/i.test(errMsg)
    ) {
      await sendAlert({
        category: 'repo_deleted',
        title: `Repo deleted: ${label}`,
        body: [
          `**${label}** releases API returned not-found.`,
          '',
          '```',
          errMsg.slice(0, 500),
          '```',
        ].join('\n'),
        subject: `archive:${archiveId}`,
        severity: 'failure',
      });
    } else {
      await sendAlert({
        category: 'sync_failed',
        title: `Release sync failed: ${label}`,
        body: `Release fetch failed for **${label}**:\n\n\`\`\`\n${errMsg.slice(0, 800)}\n\`\`\``,
        subject: `archive:${archiveId}:releases`,
        severity: 'warning',
      });
    }
  }

  // Optional: push absolute README URLs to the Wayback Machine (SPN2).
  // Best-effort — never fails the overall sync.
  if (settings.wayback_readme_urls_enabled) {
    if (!hasWaybackCredentials(settings)) {
      messages.push(
        'wayback: enabled but missing archive.org S3 API keys (set under Settings)'
      );
    } else {
      const creds = waybackCredentialsFromSettings(settings)!;
      options.onProgress?.('Submitting README URLs to Wayback Machine...');
      const { message: waybackMsg } = await archiveReadmeUrlsFromMirror(
        repo.mirror_path,
        creds
      );
      messages.push(waybackMsg);
    }
  }

  updateRepo(repo.id, { last_synced_at: new Date().toISOString() });

  addSyncLog({
    repo_id: repo.id,
    status: 'success',
    message: messages.join('; '),
  });

  return { ok: true, messages };
}
