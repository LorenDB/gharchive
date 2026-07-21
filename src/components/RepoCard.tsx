import Link from 'next/link';
import { formatRelativeTime } from '@/lib/format';

interface Repo {
  id: number;
  platform: 'github' | 'gitlab';
  owner: string;
  name: string;
  clone_url: string;
  last_synced_at: string | null;
  created_at: string;
}

export default function RepoCard({ repo }: { repo: Repo }) {
  const isGithub = repo.platform === 'github';

  return (
    <Link
      href={`/repos/${repo.id}`}
      className="group surface relative flex flex-col p-5 transition-all duration-200 hover:border-ink-600 hover:bg-ink-900 hover:-translate-y-0.5 hover:shadow-glow"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <span
          className={`badge ${
            isGithub
              ? 'bg-ink-850 text-ink-200 border border-ink-700'
              : 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
          }`}
        >
          {isGithub ? 'GitHub' : 'GitLab'}
        </span>
        <span
          className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${
            repo.last_synced_at
              ? 'bg-mint-400 shadow-[0_0_8px_rgba(94,207,154,0.5)]'
              : 'bg-ink-600'
          }`}
          title={repo.last_synced_at ? 'Synced' : 'Never synced'}
        />
      </div>

      <h2 className="font-mono text-[15px] text-white group-hover:text-amber-300 transition-colors leading-snug">
        <span className="text-ink-400 group-hover:text-amber-400/70">
          {repo.owner}
        </span>
        <span className="text-ink-600 mx-0.5">/</span>
        <span className="font-semibold">{repo.name}</span>
      </h2>

      <p className="mt-auto pt-5 text-xs text-ink-500 flex items-center gap-1.5">
        <ClockIcon />
        {repo.last_synced_at
          ? `Synced ${formatRelativeTime(repo.last_synced_at)}`
          : 'Never synced'}
      </p>
    </Link>
  );
}

function ClockIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
    </svg>
  );
}
