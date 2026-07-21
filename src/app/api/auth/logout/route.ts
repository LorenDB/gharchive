import { NextRequest, NextResponse } from 'next/server';
import {
  clearCookieOptions,
  OAUTH_COOKIE,
  SESSION_COOKIE,
} from '@/lib/session';
import { appUrl, isOidcConfigured } from '@/lib/oidc';

export async function GET(_req: NextRequest) {
  const url = appUrl(isOidcConfigured() ? '/login' : '/');
  const res = NextResponse.redirect(url);
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());
  res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
  return res;
}

export async function POST(req: NextRequest) {
  return GET(req);
}
