import Link from 'next/link';
import { formatRelativeTime } from '@/lib/format';
import { languageColor } from '@/lib/language-colors';
import { platformDisplay, isGithub } from '@/lib/platform';
import type { PendingItem } from '@/lib/import-stars';

interface ListBadge {
  id: number;
  name: string;
  color: string;
  source?: string;
}

interface Repo {
  id: number;
  platform: 'github' | 'gitlab' | string;
  owner: string;
  name: string;
  clone_url?: string;
  last_synced_at: string | null;
  created_at: string;
  from_star?: boolean;
  lists?: ListBadge[];
  remote_description?: string | null;
  local_description?: string | null;
  language?: string | null;
  topics?: string[];
  stargazers_count?: number | null;
  is_archived?: boolean;
  is_private?: boolean;
  is_fork?: boolean;
}

export default function RepoCard({ repo }: { repo: Repo }) {
  const github = isGithub(repo.platform);
  const lists = repo.lists || [];
  const blurb = repo.local_description || repo.remote_description;

  return (
    <Link
      href={`/repos/${repo.id}`}
      className={`group surface relative flex flex-col p-5 transition-all duration-200 hover:border-ink-600 hover:bg-ink-900 hover:-translate-y-0.5 hover:shadow-glow ${
        repo.is_archived ? 'border-amber-500/20' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span
            className={`badge ${
              github
                ? 'bg-ink-850 text-ink-200 border border-ink-700'
                : 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
            }`}
          >
            {platformDisplay(repo.platform)}
          </span>
          {repo.is_archived && (
            <span
              className="badge bg-amber-500/10 text-amber-300 border border-amber-500/30"
              title="Marked as archived on the remote"
            >
              archived
            </span>
          )}
        </div>
        <span
          className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${
            repo.last_synced_at
              ? 'bg-mint-400 shadow-[0_0_8px_rgba(94,207,154,0.5)]'
              : 'bg-ink-600'
          }`}
          title={repo.last_synced_at ? 'Synced' : 'Never synced'}
        />
      </div>

      <h2
        className={`font-mono text-[15px] group-hover:text-amber-300 transition-colors leading-snug ${
          repo.is_archived ? 'text-ink-300' : 'text-white'
        }`}
      >
        <span className="text-ink-400 group-hover:text-amber-400/70">
          {repo.owner}
        </span>
        <span className="text-ink-600 mx-0.5">/</span>
        <span className="font-semibold">{repo.name}</span>
      </h2>

      {blurb && (
        <p className="mt-2 text-xs text-ink-400 line-clamp-2 leading-relaxed">
          {blurb}
        </p>
      )}

      {(repo.language || (repo.topics && repo.topics.length > 0)) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {repo.language && (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-500">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: languageColor(repo.language!) }} />
              {repo.language}
            </span>
          )}
          {(repo.topics || []).slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-full px-1.5 py-0.5 text-[10px] border border-ink-700/80 text-ink-500"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {lists.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {lists.slice(0, 4).map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border border-ink-700/80 bg-ink-950/50 text-ink-300"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              {l.name}
            </span>
          ))}
          {lists.length > 4 && (
            <span className="text-[10px] text-ink-600">+{lists.length - 4}</span>
          )}
        </div>
      )}

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

function phaseLabel(item: PendingItem): string {
  if (item.phase === 'queued') return 'Awaiting import…';
  if (item.phase === 'cloning') return 'Cloning repo…';
  if (item.detail) return item.detail;
  return 'Syncing releases…';
}

export function PendingCard({ item }: { item: PendingItem }) {
  const github = isGithub(item.platform);
  const label = phaseLabel(item);

  return (
    <div className="surface relative flex flex-col p-5 opacity-60">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span
            className={`badge ${
              github
                ? 'bg-ink-850 text-ink-200 border border-ink-700'
                : 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
            }`}
          >
            {platformDisplay(item.platform)}
          </span>
        </div>
        <span className="h-2 w-2 rounded-full mt-1.5 shrink-0 bg-amber-400 animate-pulse" />
      </div>

      <h2 className="font-mono text-[15px] leading-snug text-ink-300">
        <span className="text-ink-500">{item.owner}</span>
        <span className="text-ink-600 mx-0.5">/</span>
        <span className="font-semibold text-ink-300">{item.name}</span>
      </h2>

      <p className="mt-3 text-xs text-ink-500 flex items-center gap-2">
        <svg
          className="h-3.5 w-3.5 animate-spin text-amber-400/70"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
          />
        </svg>
        {label}
      </p>
    </div>
  );
}
