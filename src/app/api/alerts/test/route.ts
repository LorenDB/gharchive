import { NextRequest, NextResponse } from 'next/server';
import { withApiUser, checkRateLimit, checkCsrf } from '@/lib/api-auth';
import {
  ALERT_CATEGORIES,
  sendTestAlert,
  type AlertCategory,
} from '@/lib/alerts';

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, { maxRequests: 5, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  const csrfFailed = checkCsrf(req);
  if (csrfFailed) return csrfFailed;

  return withApiUser(async () => {
    try {
      const body = await req.json().catch(() => ({}));
      let category: AlertCategory = 'new_release';
      if (body?.category != null) {
        if (
          typeof body.category !== 'string' ||
          !ALERT_CATEGORIES.includes(body.category as AlertCategory)
        ) {
          return NextResponse.json(
            {
              error: `category must be one of: ${ALERT_CATEGORIES.join(', ')}`,
            },
            { status: 400 }
          );
        }
        category = body.category as AlertCategory;
      }

      const result = await sendTestAlert(category);
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error || 'Test failed' },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        category,
        message: `Test alert sent for category "${category}"`,
      });
    } catch (err: any) {
      return NextResponse.json(
        { ok: false, error: err?.message || 'Test failed' },
        { status: 500 }
      );
    }
  });
}
