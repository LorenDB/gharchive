import { NextRequest, NextResponse } from 'next/server';
import {
  clearCookieOptions,
  OAUTH_COOKIE,
  SESSION_COOKIE,
} from '@/lib/session';
import { isOidcConfigured } from '@/lib/oidc';

export async function GET(req: NextRequest) {
  const url = new URL(isOidcConfigured() ? '/login' : '/', req.url);
  const res = NextResponse.redirect(url);
  res.cookies.set(SESSION_COOKIE, '', clearCookieOptions());
  res.cookies.set(OAUTH_COOKIE, '', clearCookieOptions());
  return res;
}

export async function POST(req: NextRequest) {
  return GET(req);
}
