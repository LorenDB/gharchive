import { redirect } from 'next/navigation';
import Navbar from '@/components/Navbar';
import { getCurrentUser, isAutologinMode, isOidcConfigured } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const autologin = isAutologinMode();
  const user = await getCurrentUser();

  if (isOidcConfigured() && !user) {
    redirect('/login');
  }

  return (
    <>
      <Navbar
        user={
          user
            ? {
                username: user.username,
                name: user.name,
                email: user.email,
              }
            : null
        }
        showLogout={!autologin}
      />
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {children}
      </main>
      <footer className="border-t border-ink-900/80 py-6 mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
          <span>GHArchive · local repository vault</span>
          <span className="font-mono">{autologin ? 'autologin' : 'sso'}</span>
        </div>
      </footer>
    </>
  );
}
