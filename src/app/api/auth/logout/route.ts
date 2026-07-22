import { NextRequest, NextResponse } from 'next/server';
import {
  clearCookieOptions,
  OAUTH_COOKIE,
  SESSION_COOKIE,
} from '@/lib/session';
import { appUrl, isOidcConfigured } from '@/lib/oidc';

export async function GET() {
  const url = appUrl(isOidcConfigured() ? '/login' : '/');
  return NextResponse.redirect(url);
}

function clearSession(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());
  res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
}

export async function POST(req: NextRequest) {
  const url = appUrl(isOidcConfigured() ? '/login' : '/');
  const res = NextResponse.redirect(url);
  clearSession(res);
  return res;
}
