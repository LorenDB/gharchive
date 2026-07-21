'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Repos' },
  { href: '/import', label: 'Import' },
  { href: '/lists', label: 'Lists' },
  { href: '/settings', label: 'Settings' },
];

export interface NavbarUser {
  username: string;
  name: string | null;
  email: string | null;
}

export default function Navbar({
  user,
  showLogout = false,
}: {
  user?: NavbarUser | null;
  showLogout?: boolean;
}) {
  const pathname = usePathname();
  const displayName = user?.username || 'admin';

  // Login page: minimal chrome
  if (pathname === '/login') {
    return (
      <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-975/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center">
          <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 text-ink-975 shadow-glow">
              <ArchiveIcon />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white group-hover:text-amber-300 transition-colors">
              GHArchive
            </span>
          </Link>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-975/80 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8 min-w-0">
          <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 text-ink-975 shadow-glow">
              <ArchiveIcon />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-white group-hover:text-amber-300 transition-colors">
              GHArchive
            </span>
          </Link>

          <nav className="hidden sm:flex items-center gap-1">
            {links.map((link) => {
              const active =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-ink-850 text-white'
                      : 'text-ink-400 hover:text-ink-100 hover:bg-ink-900'
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <nav className="flex sm:hidden items-center gap-1">
            {links.map((link) => {
              const active =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                    active ? 'text-amber-300' : 'text-ink-500'
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <span
            className="hidden sm:inline-flex items-center gap-1.5 badge-muted max-w-[12rem] truncate"
            title={user?.email || user?.name || displayName}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-mint-400 animate-pulse shrink-0" />
            {displayName}
          </span>
          {showLogout ? (
            <a
              href="/api/auth/logout"
              className="btn-ghost text-xs px-2 py-1 text-ink-400 hover:text-ink-100"
            >
              Log out
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function ArchiveIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.75 2.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 1 .75.75v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5A.75.75 0 0 1 1.75 7Zm4.5 1a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}
