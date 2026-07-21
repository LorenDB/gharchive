import {
  addRelease,
  addReleaseAsset,
  addSyncLog,
  updateRepo,
  tagExists as dbTagExists,
  assetExists,
  getReleaseByTag,
  getSettings,
} from '@/lib/db';
import { syncMirror } from '@/lib/git';
import {
  fetchReleases,
  downloadReleaseAsset,
  getReleaseAssetPath,
} from '@/lib/releases';

export interface RepoLike {
  id: number;
  platform: string;
  owner: string;
  name: string;
  mirror_path: string;
}

/**
 * Full sync: snapshot+fetch git mirror, then pull releases/assets.
 * When `skipGit` is true (fresh clone), only release metadata/assets are synced.
 */
export async function syncRepo(
  repo: RepoLike,
  options: { skipGit?: boolean } = {}
): Promise<{ ok: boolean; messages: string[]; error?: string }> {
  const messages: string[] = [];
  const settings = getSettings();

  if (!options.skipGit) {
    try {
      const gitMsg = await syncMirror(repo.mirror_path);
      messages.push(`git: ${gitMsg || 'up to date'}`);
    } catch (err: any) {
      addSyncLog({
        repo_id: repo.id,
        status: 'failed',
        message: `git sync failed: ${err.message}`,
      });
      return { ok: false, messages, error: err.message };
    }
  } else {
    messages.push('git: initial clone');
  }

  try {
    const projectPath = `${repo.owner}/${repo.name}`;
    const releases = await fetchReleases(
      repo.platform as 'github' | 'gitlab',
      projectPath
    );

    let newReleases = 0;
    let newAssets = 0;
    let skippedAssets = 0;
    const maxBytes =
      settings.max_asset_size_mb > 0
        ? settings.max_asset_size_mb * 1024 * 1024
        : Infinity;

    for (const rel of releases) {
      if (!dbTagExists(repo.id, rel.tag_name)) {
        addRelease({
          repo_id: repo.id,
          tag_name: rel.tag_name,
          name: rel.name,
          body: rel.body,
          published_at: rel.published_at,
        });
        newReleases++;
      }

      const releaseRow = getReleaseByTag(repo.id, rel.tag_name);
      if (!releaseRow) continue;

      for (const asset of rel.assets) {
        if (assetExists(releaseRow.id, asset.name)) continue;

        const assetPath = getReleaseAssetPath(
          repo.platform,
          repo.owner,
          repo.name,
          rel.tag_name,
          asset.name
        );

        let downloaded = false;
        const tooLarge = asset.size > 0 && asset.size > maxBytes;

        if (!settings.download_release_assets) {
          skippedAssets++;
        } else if (tooLarge) {
          skippedAssets++;
        } else if (asset.download_url) {
          downloaded = await downloadReleaseAsset(asset.download_url, assetPath);
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
  } catch (err: any) {
    messages.push(`releases: failed - ${err.message}`);
  }

  updateRepo(repo.id, { last_synced_at: new Date().toISOString() });

  addSyncLog({
    repo_id: repo.id,
    status: 'success',
    message: messages.join('; '),
  });

  return { ok: true, messages };
}
