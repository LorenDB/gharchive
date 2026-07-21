import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import AuthWarningBanner from '@/components/AuthWarningBanner';
import { isAutologinMode } from '@/lib/auth';

const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GHArchive',
  description: 'Self-hosted GitHub/GitLab repository archive',
};

// Auth mode depends on runtime env (Docker .env) — never bake at build time.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const autologin = isAutologinMode();

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans min-h-screen flex flex-col">
        {autologin ? <AuthWarningBanner /> : null}
        {children}
      </body>
    </html>
  );
}
