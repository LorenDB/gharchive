import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb, getReleaseAssets } from '@/lib/db';
import { withApiUser } from '@/lib/api-auth';
import {
  contentDisposition,
  getReleasesRoot,
  isPathInside,
  parseTrustedAssetUrl,
} from '@/lib/safe-url';
import {
  decompressFromStorage,
  isStorageCompressedPath,
} from '@/lib/asset-compression';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; assetId: string } }
) {
  return withApiUser(async () => {
    const repoId = parseInt(params.id, 10);
    const assetId = parseInt(params.assetId, 10);
    if (isNaN(repoId) || isNaN(assetId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const { repos, releases } = getDb();

    const repo = repos.find((r) => r.id === repoId);
    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const repoReleaseIds = new Set(
      releases
        .filter((r) => r.archive_id === repo.archive_id)
        .map((r) => r.id)
    );

    // Scan assets belonging to this repo's releases
    let asset = null as ReturnType<typeof getReleaseAssets>[number] | null;
    for (const relId of repoReleaseIds) {
      const found = getReleaseAssets(relId).find((a) => a.id === assetId);
      if (found) {
        asset = found;
        break;
      }
    }

    if (!asset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }

    if (asset.file_path && fs.existsSync(asset.file_path)) {
      // Confine reads to DATA_DIR/releases (no arbitrary local file read)
      if (!isPathInside(getReleasesRoot(), asset.file_path)) {
        console.error(
          `[assets] refused path outside releases root: ${asset.file_path}`
        );
        return NextResponse.json(
          { error: 'Asset file path invalid' },
          { status: 500 }
        );
      }

      // Reject symlinks that escape (realpath already checked in isPathInside)
      try {
        const st = fs.lstatSync(asset.file_path);
        if (st.isSymbolicLink()) {
          return NextResponse.json(
            { error: 'Asset file path invalid' },
            { status: 500 }
          );
        }
      } catch {
        return NextResponse.json(
          { error: 'Asset file not available locally' },
          { status: 404 }
        );
      }

      const onDisk = fs.readFileSync(asset.file_path);
      const wasCompressed =
        Boolean(asset.storage_compressed) ||
        isStorageCompressedPath(asset.file_path);
      let body: Buffer = onDisk;
      if (wasCompressed) {
        try {
          body = decompressFromStorage(onDisk);
        } catch (err) {
          console.error(
            `[assets] failed to decompress storage asset ${asset.id}:`,
            err
          );
          return NextResponse.json(
            { error: 'Asset file corrupt' },
            { status: 500 }
          );
        }
      }

      const contentType = asset.content_type || 'application/octet-stream';
      const filename = asset.name || path.basename(asset.file_path);

      return new NextResponse(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.length),
          'Content-Disposition': contentDisposition(filename, 'attachment'),
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        },
      });
    }

    if (asset.download_url) {
      const trusted = parseTrustedAssetUrl(asset.download_url);
      if (!trusted) {
        return NextResponse.json(
          { error: 'Asset download URL not trusted' },
          { status: 502 }
        );
      }
      return NextResponse.redirect(trusted.toString());
    }

    return NextResponse.json(
      { error: 'Asset file not available locally' },
      { status: 404 }
    );
  });
}
