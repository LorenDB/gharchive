'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

const links = [
  { href: '/', label: 'Repos' },
  { href: '/import', label: 'Import' },
  { href: '/lists', label: 'Lists' },
  { href: '/settings', label: 'Settings' },
];

export interface NavbarUser {
  id?: string;
  username: string;
  name: string | null;
  email: string | null;
}

function navbarDisplayName(user: NavbarUser): string {
  if (user.username && (!user.id || user.username !== user.id)) {
    return user.username;
  }
  if (user.email?.trim()) {
    const local = user.email.includes('@')
      ? user.email.split('@')[0]
      : user.email;
    if (local?.trim()) return local.trim();
  }
  if (user.name?.trim()) return user.name.trim();
  return user.username || 'admin';
}

export default function Navbar({
  user,
  showLogout = false,
}: {
  user?: NavbarUser | null;
  showLogout?: boolean;
}) {
  const pathname = usePathname();
  const displayName = user ? navbarDisplayName(user) : 'admin';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close mobile menu on navigation
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Escape + click outside
  useEffect(() => {
    if (!menuOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    function onPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    }

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [menuOpen]);

  // Prevent body scroll when mobile drawer is open
  useEffect(() => {
    if (!menuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Login page: minimal chrome
  if (pathname === '/login') {
    return (
      <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-975/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center">
          <BrandLink />
        </div>
      </header>
    );
  }

  function isActive(href: string) {
    return href === '/' ? pathname === '/' : pathname.startsWith(href);
  }

  return (
    <header className="sticky top-0 z-40 relative border-b border-ink-800/80 bg-ink-975/80 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-6 min-w-0">
          <BrandLink />

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1" aria-label="Main">
            {links.map((link) => {
              const active = isActive(link.href);
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

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <span
            className="hidden sm:inline-flex items-center gap-1.5 badge-muted max-w-[10rem] truncate"
            title={user?.email || user?.name || displayName}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-mint-400 animate-pulse shrink-0" />
            {displayName}
          </span>
          {showLogout ? (
            <a
              href="/api/auth/logout"
              className="hidden md:inline-flex btn-ghost text-xs px-2 py-1 text-ink-400 hover:text-ink-100"
            >
              Log out
            </a>
          ) : null}

          {/* Mobile / tablet hamburger */}
          <button
            ref={buttonRef}
            type="button"
            className="md:hidden inline-flex items-center justify-center h-9 w-9 rounded-lg border border-ink-700 bg-ink-900/80 text-ink-200 hover:bg-ink-850 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 top-14 z-40 bg-ink-975/60 backdrop-blur-sm"
            aria-hidden
          />
          <div
            ref={menuRef}
            id={menuId}
            className="md:hidden absolute left-0 right-0 top-full z-50 border-b border-ink-800 bg-ink-950 shadow-card"
            role="dialog"
            aria-label="Navigation menu"
          >
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3">
              <div className="sm:hidden flex items-center gap-2 px-3 py-2 mb-1 text-sm text-ink-400">
                <span className="h-1.5 w-1.5 rounded-full bg-mint-400 animate-pulse shrink-0" />
                <span className="truncate font-medium text-ink-200">
                  {displayName}
                </span>
              </div>
              <nav className="flex flex-col gap-0.5" aria-label="Main">
                {links.map((link) => {
                  const active = isActive(link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={`flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-ink-850 text-white'
                          : 'text-ink-300 hover:bg-ink-900 hover:text-white'
                      }`}
                      onClick={() => setMenuOpen(false)}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </nav>
              {showLogout ? (
                <div className="mt-2 pt-2 border-t border-ink-800">
                  <a
                    href="/api/auth/logout"
                    className="flex items-center rounded-lg px-3 py-2.5 text-sm font-medium text-ink-400 hover:bg-ink-900 hover:text-ink-100"
                  >
                    Log out
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
    </header>
  );
}

function BrandLink() {
  return (
    <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
      <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 text-ink-975 shadow-glow">
        <ArchiveIcon />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white group-hover:text-amber-300 transition-colors">
        GHArchive
      </span>
    </Link>
  );
}

function MenuIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.75 2.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 1 .75.75v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5A.75.75 0 0 1 1.75 7Zm4.5 1a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}
