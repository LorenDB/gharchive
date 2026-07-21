import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb, getReleaseAssets } from '@/lib/db';
import { withApiUser } from '@/lib/api-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; assetId: string } }
) {
  return withApiUser(async () => {
    const repoId = parseInt(params.id);
    const assetId = parseInt(params.assetId);
    const { repos, releases } = getDb();

    const repo = repos.find((r) => r.id === repoId);
    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const repoReleaseIds = new Set(
      releases.filter((r) => r.repo_id === repoId).map((r) => r.id)
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

    if (!asset.file_path || !fs.existsSync(asset.file_path)) {
      // Fall back to original download URL if we have it
      if (asset.download_url) {
        return NextResponse.redirect(asset.download_url);
      }
      return NextResponse.json(
        { error: 'Asset file not available locally' },
        { status: 404 }
      );
    }

    const buffer = fs.readFileSync(asset.file_path);
    const contentType = asset.content_type || 'application/octet-stream';
    const filename = asset.name || path.basename(asset.file_path);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });
}
