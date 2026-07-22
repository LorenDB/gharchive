import fs from 'fs';
import {
  addRelease,
  addReleaseAsset,
  addSyncLog,
  updateRepo,
  tagExists as dbTagExists,
  assetExists,
  getReleaseByTag,
  getSettings,
  getDb,
  countArchiveReleases,
} from '@/lib/db';
import { syncMirror, isRemoteMissingError, withMirrorLock } from '@/lib/git';
import {
  fetchReleases,
  downloadReleaseAsset,
  getReleaseAssetPath,
} from '@/lib/releases';
import { fetchRemoteRepoMeta } from '@/lib/remote-meta';
import { hasEnoughMemory } from '@/lib/memory';
import { sendAlert, repoLabel } from '@/lib/alerts';

export interface RepoLike {
  id: number;
  archive_id: number;
  platform: string;
  owner: string;
  name: string;
  mirror_path: string;
  is_private?: boolean;
}

/**
 * Full sync: snapshot+fetch git mirror, then pull releases/assets.
 * When `skipGit` is true (fresh clone), only release metadata/assets are synced.
 * Content is stored on the shared archive; sync_logs attach to the membership id.
 * Emits Apprise alerts for major archive events when configured.
 */
export async function syncRepo(
  repo: RepoLike,
  options: { skipGit?: boolean } = {}
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

  // Scrape remote description / topics / stars / archived (best-effort)
  try {
    if (repo.platform === 'github' || repo.platform === 'gitlab') {
      const prior = getDb().repos.find((r) => r.id === repo.id);
      const wasArchived = Boolean(prior?.is_archived);
      const hadRemoteMeta = Boolean(prior?.remote_meta_synced_at);

      const meta = await fetchRemoteRepoMeta(
        repo.platform,
        repo.owner,
        repo.name
      );
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
    }
  } catch (err: any) {
    messages.push(`meta: failed - ${err?.message || err}`);
  }

  const priorReleaseCount = countArchiveReleases(archiveId);
  const newReleaseTags: string[] = [];

  try {
    const projectPath = `${repo.owner}/${repo.name}`;
    const releases = await fetchReleases(
      repo.platform as 'github' | 'gitlab',
      projectPath
    );

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
    const maxBytes =
      settings.max_asset_size_mb > 0
        ? settings.max_asset_size_mb * 1024 * 1024
        : Infinity;

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

      const releaseRow = getReleaseByTag(archiveId, rel.tag_name);
      if (!releaseRow) continue;

      for (const asset of rel.assets) {
        if (assetExists(releaseRow.id, asset.name)) continue;

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

        if (!settings.download_release_assets) {
          skippedAssets++;
        } else if (tooLarge) {
          skippedAssets++;
        } else if (asset.download_url) {
          if (asset.size > 10 * 1024 * 1024) {
            const assetMemCheck = hasEnoughMemory(
              Math.ceil(asset.size / 1024 / 1024) + settings.min_free_memory_mb
            );
            if (!assetMemCheck.ok) {
              skippedAssets++;
              continue;
            }
          }
          // If file already exists (shared path from another user's sync), link it
          if (fs.existsSync(assetPath)) {
            downloaded = true;
          } else {
            downloaded = await downloadReleaseAsset(
              asset.download_url,
              assetPath
            );
          }
        }

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

    let releaseMsg = `releases: ${releases.length} fetched (${newReleases} new, ${newAssets} assets)`;
    if (skippedAssets > 0) releaseMsg += `, ${skippedAssets} skipped`;
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
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    messages.push(`releases: failed - ${errMsg}`);

    if (
      isRemoteMissingError(errMsg) ||
      /GitHub API error: 404/i.test(errMsg) ||
      /GitLab API error: 404/i.test(errMsg)
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

  updateRepo(repo.id, { last_synced_at: new Date().toISOString() });

  addSyncLog({
    repo_id: repo.id,
    status: 'success',
    message: messages.join('; '),
  });

  return { ok: true, messages };
}
