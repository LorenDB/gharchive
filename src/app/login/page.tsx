import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, isOidcConfigured } from '@/lib/auth';
import { getOidcProviderName } from '@/lib/oidc';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  // Autologin: nothing to do
  if (!isOidcConfigured()) {
    redirect('/');
  }

  const user = await getCurrentUser();
  if (user) {
    redirect('/');
  }

  const next =
    searchParams.next && searchParams.next.startsWith('/')
      ? searchParams.next
      : '/';
  const error = searchParams.error;
  const loginHref = `/api/auth/login?next=${encodeURIComponent(next)}`;

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="surface-solid w-full max-w-md p-8 shadow-glow">
        <div className="flex items-center gap-3 mb-6">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 text-ink-975">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
              <path d="M1.75 2.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 1 .75.75v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5A.75.75 0 0 1 1.75 7Zm4.5 1a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5Z" />
            </svg>
          </span>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-tight">
              Sign in to GHArchive
            </h1>
            <p className="text-sm text-ink-400">
              Single sign-on via your identity provider
            </p>
          </div>
        </div>

        {error ? (
          <div
            className="mb-5 rounded-lg border border-red-900/70 bg-red-950/40 px-3.5 py-3 text-sm text-red-300"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <a href={loginHref} className="btn-primary w-full text-center">
          Continue with {getOidcProviderName()}
        </a>

        <p className="text-center mt-4">
          <Link
            href="/"
            className="text-xs text-ink-500 hover:text-ink-300 transition-colors"
          >
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
