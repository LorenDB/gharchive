'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import RepoTree from '@/components/RepoTree';
import ReleasesViewer from '@/components/ReleasesViewer';
import { formatBytes, formatDate, formatRelativeTime } from '@/lib/format';

type Tab = 'code' | 'releases' | 'activity';

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [repo, setRepo] = useState<any>(null);
  const [allLists, setAllLists] = useState<any[]>([]);
  const [releases, setReleases] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<Tab>('code');
  const [syncError, setSyncError] = useState('');
  const [listOpen, setListOpen] = useState(false);

  const fetchData = useCallback(async () => {
    const [repoRes, releaseRes] = await Promise.all([
      fetch(`/api/repos/${id}`),
      fetch(`/api/repos/${id}/releases`),
    ]);
    if (repoRes.ok) {
      const data = await repoRes.json();
      setRepo(data.repo);
      setAllLists(data.allLists || []);
      setSyncLogs(data.syncLogs || []);
    }
    if (releaseRes.ok) {
      const data = await releaseRes.json();
      setReleases(data);
    }
    setLoading(false);
  }, [id]);

  async function toggleList(listId: number) {
    if (!repo) return;
    const current: number[] = (repo.lists || []).map((l: any) => l.id);
    const next = current.includes(listId)
      ? current.filter((x) => x !== listId)
      : [...current, listId];
    const res = await fetch(`/api/repos/${id}/lists`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_ids: next }),
    });
    if (res.ok) {
      const data = await res.json();
      setRepo((r: any) => ({ ...r, lists: data.lists }));
    }
  }

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleSync() {
    setSyncing(true);
    setSyncError('');
    try {
      const res = await fetch(`/api/repos/${id}/sync`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Sync failed');
      }
      await fetchData();
    } catch (err: any) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this repository and all its archived data?')) return;
    await fetch(`/api/repos/${id}`, { method: 'DELETE' });
    router.push('/');
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 rounded-lg bg-ink-900 animate-pulse" />
        <div className="h-4 w-72 rounded bg-ink-900/80 animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="stat-card h-20 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="surface px-6 py-12 text-center">
        <p className="text-ink-400">Repository not found.</p>
        <button onClick={() => router.push('/')} className="btn-ghost mt-4">
          ← Back to library
        </button>
      </div>
    );
  }

  const isGithub = repo.platform === 'github';

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'code', label: 'Code' },
    { id: 'releases', label: 'Releases', count: releases.length },
    { id: 'activity', label: 'Activity', count: syncLogs.length },
  ];

  return (
    <div>
      <button
        onClick={() => router.push('/')}
        className="btn-ghost !px-0 !py-0 mb-4 text-ink-500 hover:text-ink-200"
      >
        ← Library
      </button>

      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5 mb-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span
              className={`badge ${
                isGithub
                  ? 'bg-ink-850 text-ink-200 border border-ink-700'
                  : 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
              }`}
            >
              {isGithub ? 'GitHub' : 'GitLab'}
            </span>
            {repo.last_synced_at && (
              <span className="badge-mint">
                synced {formatRelativeTime(repo.last_synced_at)}
              </span>
            )}
            {repo.from_star && <span className="badge-amber">from star</span>}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight font-mono text-white break-all">
            <span className="text-ink-400">{repo.owner}</span>
            <span className="text-ink-600">/</span>
            {repo.name}
          </h1>
          <p className="text-sm text-ink-500 mt-2 font-mono break-all">
            {repo.clone_url}
          </p>
          {repo.last_synced_at && (
            <p className="text-xs text-ink-600 mt-2">
              Last full sync {formatDate(repo.last_synced_at)}
            </p>
          )}

          {/* Lists */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(repo.lists || []).map((l: any) => (
              <span
                key={l.id}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border border-ink-700 bg-ink-950/50 text-ink-200"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.name}
              </span>
            ))}
            <div className="relative">
              <button
                type="button"
                className="btn-ghost !py-0.5 !px-2 text-xs"
                onClick={() => setListOpen((o) => !o)}
              >
                Edit lists
              </button>
              {listOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setListOpen(false)}
                  />
                  <div className="absolute left-0 top-full mt-1 z-20 w-56 max-h-64 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 shadow-card p-1">
                    {allLists.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-ink-500">
                        No lists yet.{' '}
                        <a href="/lists" className="text-amber-400">
                          Create one
                        </a>
                      </p>
                    ) : (
                      allLists.map((l: any) => {
                        const on = (repo.lists || []).some(
                          (x: any) => x.id === l.id
                        );
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => toggleList(l.id)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left hover:bg-ink-850"
                          >
                            <span
                              className={`h-3.5 w-3.5 rounded border flex items-center justify-center text-[10px] ${
                                on
                                  ? 'bg-amber-400 border-amber-400 text-ink-975'
                                  : 'border-ink-600'
                              }`}
                            >
                              {on ? '✓' : ''}
                            </span>
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: l.color }}
                            />
                            <span className="truncate text-ink-200">{l.name}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn-primary"
          >
            {syncing ? (
              <>
                <Spinner /> Syncing…
              </>
            ) : (
              <>
                <SyncIcon /> Sync now
              </>
            )}
          </button>
          <button onClick={handleDelete} className="btn-danger">
            Delete
          </button>
        </div>
      </div>

      {syncError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {syncError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-8">
        <Stat label="Branches" value={repo.branch_count ?? '—'} />
        <Stat label="Tags" value={repo.tag_count ?? '—'} />
        <Stat label="Releases" value={releases.length} />
        <Stat
          label="Mirror size"
          value={repo.size_bytes != null ? formatBytes(repo.size_bytes) : '—'}
        />
      </div>

      <div className="border-b border-ink-800 mb-5">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={active ? 'tab-btn-active' : 'tab-btn-idle'}
              >
                {t.label}
                {typeof t.count === 'number' && (
                  <span
                    className={`ml-2 inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 text-[10px] font-mono ${
                      active
                        ? 'bg-amber-400/15 text-amber-300'
                        : 'bg-ink-850 text-ink-500'
                    }`}
                  >
                    {t.count}
                  </span>
                )}
                {active && (
                  <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-amber-400" />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {tab === 'code' && <RepoTree repoId={String(id)} />}
      {tab === 'releases' && (
        <ReleasesViewer repoId={id} releases={releases} />
      )}
      {tab === 'activity' && (
        <section>
          {syncLogs.length === 0 ? (
            <div className="surface px-6 py-10 text-center text-sm text-ink-500">
              No sync history yet.
            </div>
          ) : (
            <div className="surface overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-ink-500 border-b border-ink-800 bg-ink-950/50">
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncLogs.map((log: any) => (
                      <tr
                        key={log.id}
                        className="border-b border-ink-800/50 last:border-0 hover:bg-ink-900/40"
                      >
                        <td className="px-4 py-3">
                          <span
                            className={
                              log.status === 'success'
                                ? 'badge-mint'
                                : 'badge bg-red-500/10 text-red-400 border border-red-500/25'
                            }
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-ink-500 font-mono text-xs whitespace-nowrap">
                          {formatDate(log.created_at)}
                        </td>
                        <td className="px-4 py-3 text-ink-400 font-mono text-xs max-w-md truncate">
                          {log.message || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-card">
      <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">
        {label}
      </p>
      <p className="text-xl font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function SyncIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
    </svg>
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
