import { NextResponse } from 'next/server';
import {
  authStatus,
  getCurrentUser,
  publicUser,
} from '@/lib/auth';

export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json({
    user: publicUser(user),
    ...authStatus(),
  });
}
