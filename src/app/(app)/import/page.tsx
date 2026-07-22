'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { languageColor } from '@/lib/language-colors';

interface Star {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  private: boolean;
  archived: boolean;
  list_ids: string[];
  starred_at: string | null;
}

interface GhList {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  count: number;
  repos: string[];
}

interface Job {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current: string | null;
  errors: { repo: string; error: string }[];
  started_at: string | null;
  finished_at: string | null;
}

type Segment = 'all' | 'unlisted' | string; // string = list id

export default function ImportStarsPage() {
  const [account, setAccount] = useState<{ username: string } | null>(null);
  const [stars, setStars] = useState<Star[]>([]);
  const [lists, setLists] = useState<GhList[]>([]);
  const [unlisted, setUnlisted] = useState<string[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [segment, setSegment] = useState<Segment>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [importing, setImporting] = useState(false);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const accRes = await fetch('/api/github');
      const accData = await accRes.json();
      if (!accData.account) {
        setAccount(null);
        setLoading(false);
        return;
      }
      setAccount(accData.account);

      const res = await fetch('/api/github/stars');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load stars');
      setStars(data.stars);
      setLists(data.lists);
      setUnlisted(data.unlisted);
      setStats(data.stats);
      // Preselect not-yet-archived
      setSelected(
        new Set(
          data.stars.filter((s: Star) => !s.archived).map((s: Star) => s.full_name)
        )
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPreview();
    fetch('/api/github/import')
      .then((r) => r.json())
      .then((d) => setJob(d.job))
      .catch(() => {});
  }, [loadPreview]);

  // Poll import job
  useEffect(() => {
    if (!importing && !job?.running) return;
    const t = setInterval(async () => {
      const res = await fetch('/api/github/import');
      const data = await res.json();
      setJob(data.job);
      if (!data.job?.running) {
        setImporting(false);
        loadPreview();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [importing, job?.running, loadPreview]);

  const visibleStars = useMemo(() => {
    if (segment === 'all') return stars;
    if (segment === 'unlisted') {
      const set = new Set(unlisted);
      return stars.filter((s) => set.has(s.full_name));
    }
    return stars.filter((s) => s.list_ids.includes(segment));
  }, [stars, segment, unlisted]);

  const visibleSelectedCount = visibleStars.filter((s) =>
    selected.has(s.full_name)
  ).length;

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectVisible(onlyNew = false) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visibleStars) {
        if (onlyNew && s.archived) continue;
        next.add(s.full_name);
      }
      return next;
    });
  }

  function clearVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visibleStars) next.delete(s.full_name);
      return next;
    });
  }

  async function startImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setError('');
    try {
      const res = await fetch('/api/github/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_names: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setJob(data.job);
    } catch (err: any) {
      setError(err.message);
      setImporting(false);
    }
  }

  async function cancelImport() {
    try {
      const res = await fetch('/api/github/import', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancel failed');
      setJob(data.job);
      setImporting(false);
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-ink-500 text-sm">
        <Spinner /> Loading stars from GitHub…
      </div>
    );
  }

  if (!account) {
    return (
      <div className="max-w-lg">
        <h1 className="page-title mb-2">Import stars</h1>
        <div className="surface p-6">
          <p className="text-sm text-ink-300 mb-4">
            Link a GitHub personal access token in Settings to import your starred
            repositories and star lists.
          </p>
          <Link href="/settings" className="btn-primary">
            Open settings
          </Link>
        </div>
      </div>
    );
  }

  const progress =
    job && job.total > 0
      ? Math.round(
          ((job.completed + job.failed + job.skipped) / job.total) * 100
        )
      : 0;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-amber-400/80 mb-2">
            GitHub · @{account.username}
          </p>
          <h1 className="page-title">Import stars</h1>
          <p className="page-subtitle">
            {stats
              ? `${stats.total_stars} stars · ${stats.lists} lists · ${stats.archived} already archived`
              : 'Select repositories to mirror'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={loadPreview}
            disabled={importing || job?.running}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={
              selected.size === 0 || importing || Boolean(job?.running)
            }
            onClick={startImport}
          >
            {job?.running || importing
              ? 'Importing…'
              : `Import ${selected.size} selected`}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {(job?.running || job?.finished_at) && (
        <div className="surface p-4 mb-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm font-medium text-ink-200">
              {job.running
                ? `Importing${job.current ? `: ${job.current}` : '…'}`
                : job.current === 'cancelled'
                ? 'Import cancelled'
                : 'Import finished'}
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-ink-500">
                {job.completed} ok · {job.skipped} skipped · {job.failed} failed
                {job.total ? ` / ${job.total}` : ''}
              </span>
              {job.running && (
                <button
                  type="button"
                  className="btn-ghost !py-0.5 !px-2 text-xs text-red-400 hover:text-red-300"
                  onClick={cancelImport}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
          <div className="h-2 rounded-full bg-ink-850 overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          {job.errors.length > 0 && (
            <ul className="mt-3 space-y-1 max-h-32 overflow-y-auto">
              {job.errors.slice(0, 20).map((e) => (
                <li key={e.repo} className="text-xs text-red-400 font-mono">
                  {e.repo}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* List segments */}
        <aside className="lg:w-56 shrink-0">
          <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-2 px-1">
            Segment by list
          </p>
          <div className="surface overflow-hidden divide-y divide-ink-800/80">
            <SegmentBtn
              active={segment === 'all'}
              onClick={() => setSegment('all')}
              label="All stars"
              count={stars.length}
            />
            {lists.map((l) => (
              <SegmentBtn
                key={l.id}
                active={segment === l.id}
                onClick={() => setSegment(l.id)}
                label={l.name}
                count={l.count}
                privateList={l.isPrivate}
              />
            ))}
            <SegmentBtn
              active={segment === 'unlisted'}
              onClick={() => setSegment('unlisted')}
              label="Unlisted"
              count={unlisted.length}
            />
          </div>
        </aside>

        {/* Repo table */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button
              type="button"
              className="btn-ghost !py-1 !px-2 text-xs"
              onClick={() => selectVisible(true)}
            >
              Select new in view
            </button>
            <button
              type="button"
              className="btn-ghost !py-1 !px-2 text-xs"
              onClick={() => selectVisible(false)}
            >
              Select all in view
            </button>
            <button
              type="button"
              className="btn-ghost !py-1 !px-2 text-xs"
              onClick={clearVisible}
            >
              Clear view
            </button>
            <span className="text-xs text-ink-500 ml-auto">
              {visibleSelectedCount}/{visibleStars.length} selected in view
            </span>
          </div>

          <div className="surface overflow-hidden">
            {visibleStars.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-500">
                No stars in this segment.
              </p>
            ) : (
              <ul className="divide-y divide-ink-800/60 max-h-[32rem] overflow-y-auto">
                {visibleStars.map((s) => {
                  const checked = selected.has(s.full_name);
                  const listNames = lists
                    .filter((l) => s.list_ids.includes(l.id))
                    .map((l) => l.name);
                  return (
                    <li key={s.full_name}>
                      <label className="flex items-start gap-3 px-4 py-3 hover:bg-ink-900/50 cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-1 rounded border-ink-600 bg-ink-950 text-amber-400 focus:ring-amber-400/40"
                          checked={checked}
                          onChange={() => toggle(s.full_name)}
                          disabled={job?.running}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-white">
                              {s.full_name}
                            </span>
                            {s.archived && (
                              <span className="badge-mint">archived</span>
                            )}
                            {s.private && (
                              <span className="badge-muted">private</span>
                            )}
                            {s.language && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: languageColor(s.language) }} />
                                {s.language}
                              </span>
                            )}
                          </div>
                          {s.description && (
                            <p className="text-xs text-ink-500 mt-0.5 line-clamp-1">
                              {s.description}
                            </p>
                          )}
                          {listNames.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {listNames.map((n) => (
                                <span key={n} className="badge-amber">
                                  {n}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  label,
  count,
  privateList,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  privateList?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
        active
          ? 'bg-amber-400/10 text-amber-300'
          : 'text-ink-300 hover:bg-ink-900/80'
      }`}
    >
      <span className="truncate flex items-center gap-1.5">
        {label}
        {privateList && (
          <span className="text-[10px] text-ink-600">priv</span>
        )}
      </span>
      <span className="font-mono text-[11px] text-ink-500 shrink-0">{count}</span>
    </button>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}
