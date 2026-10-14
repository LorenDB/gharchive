import { NextRequest, NextResponse } from 'next/server';

export function middleware(_request: NextRequest) {
  // CSP without nonce/strict-dynamic: the nonce was generated but never wired
  // into Next's inline scripts, so strict-dynamic made the policy decorative.
  // Keep a tight static policy; raw-repo HTML/SVG is already sandboxed in the
  // /raw route (nosniff + DENY + sandbox + forced attachment).
  const csp = [
    `default-src 'self'`,
    `script-src 'self'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    `object-src 'none'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join('; ');

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Skip static assets and Next internals so they aren't delayed by CSP middleware
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
