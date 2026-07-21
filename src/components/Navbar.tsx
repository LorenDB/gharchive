'use client';

import Link from 'next/link';

export default function Navbar() {
  return (
    <nav className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold tracking-tight text-white">
          GHArchive
        </Link>
        <span className="text-sm text-gray-400">admin</span>
      </div>
    </nav>
  );
}
