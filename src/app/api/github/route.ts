import { NextRequest, NextResponse } from 'next/server';
import {
  getGithubAccountPublic,
  setGithubAccount,
  clearGithubAccount,
} from '@/lib/db';
import { validateGithubToken } from '@/lib/github';
import { withApiUser } from '@/lib/api-auth';

export async function GET() {
  return withApiUser(async () => {
    return NextResponse.json({ account: getGithubAccountPublic() });
  });
}

/** Link a GitHub account via personal access token. */
export async function PUT(req: NextRequest) {
  return withApiUser(async () => {
    try {
      const body = await req.json();
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) {
        return NextResponse.json({ error: 'token is required' }, { status: 400 });
      }

      const user = await validateGithubToken(token);
      const account = setGithubAccount({
        username: user.login,
        token,
        linked_at: new Date().toISOString(),
        last_stars_import_at: null,
        last_stars_scan_at: null,
        last_owned_scan_at: null,
        last_owned_import_at: null,
      });

      return NextResponse.json({
        account: getGithubAccountPublic(),
        user,
      });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
  });
}

export async function DELETE() {
  return withApiUser(async () => {
    clearGithubAccount();
    return NextResponse.json({ ok: true });
  });
}
