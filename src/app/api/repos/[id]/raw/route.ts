import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getDb } from '@/lib/db';
import {
  getDefaultBranch,
  getRawFile,
  contentTypeForPath,
  normalizeRepoRelativePath,
  shouldForceAttachment,
} from '@/lib/git';
import { withApiUser } from '@/lib/api-auth';
import { contentDisposition } from '@/lib/safe-url';

/**
 * Serve a raw file from the bare mirror (images for README, etc.).
 * GET /api/repos/:id/raw?path=docs/logo.png&ref=main
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  return withApiUser(async () => {
    const { repos } = getDb();
    const repo = repos.find((r) => r.id === parseInt(params.id, 10));

    if (!repo) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const url = new URL(req.url);
    const filePath = url.searchParams.get('path');
    let ref = url.searchParams.get('ref') || '';

    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    // Extra guard against path tricks in the query string
    const normalized = normalizeRepoRelativePath('', filePath);
    if (!normalized) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    try {
      if (!ref) {
        ref = await getDefaultBranch(repo.mirror_path);
      }

      const { buffer, size } = await getRawFile(
        repo.mirror_path,
        ref,
        normalized
      );
      const contentType = contentTypeForPath(normalized);
      const name = path.basename(normalized) || 'file';
      const forceAttach = shouldForceAttachment(normalized);

      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Length': String(size),
        // Images are immutable for a given ref+path tip; short cache is fine
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        // Mitigate XSS if a malicious HTML/SVG is opened in a top-level tab
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; sandbox",
      };

      if (forceAttach) {
        headers['Content-Disposition'] = contentDisposition(name, 'attachment');
      } else {
        headers['Content-Disposition'] = contentDisposition(name, 'inline');
      }

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers,
      });
    } catch (err: any) {
      const msg = err?.message || 'Failed to read file';
      const status = /not found|does not exist|pathspec|Invalid/i.test(msg)
        ? 404
        : /too large/i.test(msg)
          ? 413
          : 400;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
