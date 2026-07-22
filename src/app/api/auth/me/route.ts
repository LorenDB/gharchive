import { NextRequest, NextResponse } from 'next/server';
import {
  authStatus,
  getCurrentUser,
  publicUser,
} from '@/lib/auth';
import { checkRateLimit } from '@/lib/api-auth';

export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(request, { maxRequests: 30, windowMs: 60_000 });
  if (rateLimit) return rateLimit;

  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      user: publicUser(user),
      ...authStatus(),
    },
    {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }
  );
}
