import { NextRequest, NextResponse } from 'next/server';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import {
  listAssetHostDecisions,
  approveAssetHost,
  rejectAssetHost,
  revokeAssetHostDecision,
  normalizeAssetHostname,
} from '@/lib/asset-hosts';

export async function GET() {
  return withApiUser(async () => {
    return NextResponse.json(listAssetHostDecisions());
  });
}

/**
 * Body: { action: 'approve' | 'reject' | 'revoke', hostname: string }
 */
export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const body = await req.json();
      const action = body?.action;
      const hostname = normalizeAssetHostname(String(body?.hostname || ''));

      if (!hostname) {
        return NextResponse.json(
          { error: 'hostname is required' },
          { status: 400 }
        );
      }
      if (action !== 'approve' && action !== 'reject' && action !== 'revoke') {
        return NextResponse.json(
          { error: 'action must be approve, reject, or revoke' },
          { status: 400 }
        );
      }

      if (action === 'approve') {
        const result = await approveAssetHost(hostname);
        return NextResponse.json(result);
      }
      if (action === 'reject') {
        return NextResponse.json(rejectAssetHost(hostname));
      }
      return NextResponse.json(revokeAssetHostDecision(hostname));
    } catch (err: any) {
      return NextResponse.json(
        { error: err?.message || 'Failed' },
        { status: 400 }
      );
    }
  });
}
