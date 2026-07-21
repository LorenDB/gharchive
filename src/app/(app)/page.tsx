'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import RepoCard from '@/components/RepoCard';
import AddRepoForm from '@/components/AddRepoForm';

interface ListFilter {
  id: number;
  name: string;
  color: string;
  source: string;
  repo_count: number;
}

function DashboardInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const listParam = searchParams.get('list');
  const activeListId = listParam ? parseInt(listParam, 10) : null;

  const [repos, setRepos] = useState<any[]>([]);
  const [lists, setLists] = useState<ListFilter[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const qs =
        activeListId && !isNaN(activeListId)
          ? `?list_id=${activeListId}`
          : '';
      const [reposRes, listsRes] = await Promise.all([
        fetch(`/api/repos${qs}`),
        fetch('/api/lists'),
      ]);
      if (reposRes.ok) setRepos(await reposRes.json());
      if (listsRes.ok) {
        const data = await listsRes.json();
        setLists(data.lists || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [activeListId]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const synced = repos.filter((r) => r.last_synced_at).length;
  const activeList = lists.find((l) => l.id === activeListId);

  function setListFilter(id: number | null) {
    if (id == null) router.push('/');
    else router.push(`/?list=${id}`);
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-amber-400/80 mb-2">
            Library
          </p>
          <h1 className="page-title">
            {activeList ? activeList.name : 'Repositories'}
          </h1>
          <p className="page-subtitle">
            {loading
              ? 'Loading archive…'
              : repos.length === 0
                ? activeList
                  ? 'No repositories in this list.'
                  : 'Your vault is empty — add a repository to begin.'
                : `${repos.length} archived · ${synced} synced`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/import" className="btn-secondary">
            Import stars
          </Link>
          <AddRepoForm onAdded={fetchData} />
        </div>
      </div>

      {/* List filters */}
      {lists.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <FilterChip
            active={activeListId == null}
            onClick={() => setListFilter(null)}
            label="All"
          />
          {lists.map((l) => (
            <FilterChip
              key={l.id}
              active={activeListId === l.id}
              onClick={() => setListFilter(l.id)}
              label={l.name}
              color={l.color}
              count={l.repo_count}
            />
          ))}
          <Link
            href="/lists"
            className="inline-flex items-center px-2.5 py-1 rounded-full text-xs text-ink-500 hover:text-ink-200 border border-dashed border-ink-700 hover:border-ink-500"
          >
            Manage lists
          </Link>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="surface h-36 animate-pulse bg-ink-900/40" />
          ))}
        </div>
      ) : repos.length === 0 ? (
        <div className="surface relative overflow-hidden px-6 py-16 text-center">
          <div className="absolute inset-0 bg-gradient-to-b from-amber-400/5 to-transparent pointer-events-none" />
          <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-850 border border-ink-700 text-amber-400 mb-5 shadow-glow">
            <EmptyIcon />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">
            {activeList ? 'Empty list' : 'No repositories yet'}
          </h2>
          <p className="text-sm text-ink-400 max-w-sm mx-auto mb-6">
            {activeList
              ? 'Assign repos to this list from a repo page, or import stars.'
              : 'Mirror any public GitHub or GitLab repository, or import your starred repos.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/import" className="btn-secondary">
              Import stars
            </Link>
            <AddRepoForm onAdded={fetchData} />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  return (
    <Suspense
      fallback={
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="surface h-36 animate-pulse bg-ink-900/40" />
          ))}
        </div>
      }
    >
      <DashboardInner />
    </Suspense>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  color,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
        active
          ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
          : 'border-ink-700 bg-ink-900/50 text-ink-400 hover:text-ink-200 hover:border-ink-600'
      }`}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {label}
      {typeof count === 'number' && (
        <span className="font-mono text-[10px] opacity-70">{count}</span>
      )}
    </button>
  );
}

function EmptyIcon() {
  return (
    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.75 2.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 1 .75.75v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5A.75.75 0 0 1 1.75 7Zm4.5 1a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}
