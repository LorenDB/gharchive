'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import RepoTree from '@/components/RepoTree';
import ReleasesViewer from '@/components/ReleasesViewer';
import ReadmePanel from '@/components/ReadmePanel';
import LocalDescriptionEditor from '@/components/LocalDescriptionEditor';
import { formatBytes, formatDate, formatRelativeTime } from '@/lib/format';
import {
  isGithub,
  platformDisplay,
  repoRemoteUrl,
} from '@/lib/platform';
import { languageColor } from '@/lib/language-colors';

type Tab = 'overview' | 'code' | 'releases' | 'activity';

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [repo, setRepo] = useState<any>(null);
  const [allLists, setAllLists] = useState<any[]>([]);
  const [releases, setReleases] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
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
    if (
      !confirm(
        'Remove this repository from your account? Shared archives are kept until no users reference them.'
      )
    )
      return;
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

  const github = isGithub(repo.platform);
  const topics: string[] = Array.isArray(repo.topics) ? repo.topics : [];
  const remoteHtml = repoRemoteUrl(repo);
  const platformName = platformDisplay(repo.platform);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
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

      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5 mb-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span
              className={`badge ${
                github
                  ? 'bg-ink-850 text-ink-200 border border-ink-700'
                  : 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
              }`}
            >
              {platformName}
            </span>
            {repo.is_private && (
              <span className="badge-muted">private</span>
            )}
            {repo.is_fork && <span className="badge-muted">fork</span>}
            {repo.is_archived && (
              <span
                className="badge bg-amber-500/10 text-amber-300 border border-amber-500/30"
                title="This repository is marked as archived on the remote host"
              >
                archived upstream
              </span>
            )}
            {repo.remote_deleted_at && (
              <span
                className="badge bg-red-500/10 text-red-300 border border-red-500/30"
                title={`Remote repository gone since ${repo.remote_deleted_at}`}
              >
                deleted upstream
              </span>
            )}
            {repo.last_synced_at && (
              <span className="badge-mint">
                synced {formatRelativeTime(repo.last_synced_at)}
              </span>
            )}
            {repo.from_star && <span className="badge-amber">from star</span>}
            {repo.from_owned && (
              <span className="badge-amber">owned</span>
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight font-mono text-white break-all">
            <span className="text-ink-400">{repo.owner}</span>
            <span className="text-ink-600">/</span>
            {repo.name}
          </h1>

          {repo.remote_description && (
            <p className="text-sm text-ink-300 mt-2 leading-relaxed max-w-2xl">
              {repo.remote_description}
            </p>
          )}

          {topics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border border-amber-400/20 bg-amber-400/5 text-amber-200/90"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-500">
            {repo.language && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: languageColor(repo.language) }} />
                {repo.language}
              </span>
            )}
            {repo.stargazers_count != null && (
              <span className="inline-flex items-center gap-1 font-mono">
                <StarIcon />
                {formatCount(repo.stargazers_count)}
              </span>
            )}
            {repo.forks_count != null && (
              <span className="inline-flex items-center gap-1 font-mono">
                <ForkIcon />
                {formatCount(repo.forks_count)}
              </span>
            )}
            {repo.license && (
              <span className="font-mono">{repo.license}</span>
            )}
            {repo.homepage && (
              <a
                href={
                  repo.homepage.startsWith('http')
                    ? repo.homepage
                    : `https://${repo.homepage}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400/90 hover:text-amber-300 truncate max-w-[16rem]"
              >
                {stripUrl(repo.homepage)}
              </a>
            )}
            {remoteHtml && (
              <a
                href={remoteHtml}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-400 hover:text-ink-200"
              >
                View on {platformName} ↗
              </a>
            )}
          </div>

          <p className="text-sm text-ink-500 mt-2 font-mono break-all">
            {repo.clone_url}
          </p>
          {repo.last_synced_at && (
            <p className="text-xs text-ink-600 mt-2">
              Last full sync {formatDate(repo.last_synced_at)}
              {repo.remote_meta_synced_at && (
                <>
                  {' '}
                  · remote meta {formatRelativeTime(repo.remote_meta_synced_at)}
                </>
              )}
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

      {repo.is_archived && (
        <div className="mb-6 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200/90 flex items-start gap-2.5">
          <ArchiveIcon />
          <div>
            <p className="font-medium text-amber-200">Archived upstream</p>
            <p className="text-amber-200/70 mt-0.5 leading-relaxed">
              This repository is marked as archived on{' '}
              {platformName}. The local mirror and releases
              are still kept; new commits or releases from upstream are unlikely.
            </p>
          </div>
        </div>
      )}

      {repo.remote_deleted_at && (
        <div className="mb-6 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200/90 flex items-start gap-2.5">
          <DeleteIcon />
          <div>
            <p className="font-medium text-red-200">Deleted upstream</p>
            <p className="text-red-200/70 mt-0.5 leading-relaxed">
              This repository appears to be gone or inaccessible on{' '}
              {platformName} (detected{' '}
              {new Date(repo.remote_deleted_at).toLocaleDateString()}
              ). The local mirror and archived releases
              are still kept.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Branches" value={repo.branch_count ?? '—'} />
        <Stat label="Tags" value={repo.tag_count ?? '—'} />
        <Stat label="Releases" value={releases.length} />
        <Stat
          label="Mirror size"
          value={
            repo.size_bytes != null ? (
              <SizeChip
                total={repo.size_bytes}
                code={repo.code_size_bytes ?? 0}
                assets={repo.asset_size_bytes ?? 0}
              />
            ) : (
              '—'
            )
          }
        />
      </div>

      <div className="mb-6">
        <LocalDescriptionEditor
          repoId={String(id)}
          value={repo.local_description}
          onSaved={(next) =>
            setRepo((r: any) => (r ? { ...r, local_description: next } : r))
          }
        />
      </div>

      <div className="border-b border-ink-800 mb-5">
        <nav className="flex items-center gap-1 -mb-px overflow-x-auto">
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={active ? 'tab-btn-active' : 'tab-btn-idle'}
              >
                <span className="leading-none">{t.label}</span>
                {typeof t.count === 'number' && (
                  <span
                    className={`tab-count ${
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

      {tab === 'overview' && <ReadmePanel repoId={String(id)} />}
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function Stat({ label, value }: { label: string; value: number | string | React.ReactNode }) {
  return (
    <div className="stat-card">
      <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">
        {label}
      </p>
      <p className="text-xl font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function SizeChip({
  total,
  code,
  assets,
}: {
  total: number;
  code: number;
  assets: number;
}) {
  const hasAssets = assets > 0;
  const codePct = total > 0 ? (code / total) * 100 : 0;
  const assetPct = total > 0 ? (assets / total) * 100 : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xl font-semibold tabular-nums text-white">
        {formatBytes(total)}
      </span>
      <div className="flex flex-col gap-0.5 text-[10px] leading-tight">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded bg-blue-400" />
          <span className="text-ink-400">
            Code {formatBytes(code)} ({codePct.toFixed(0)}%)
          </span>
        </span>
        {hasAssets && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded bg-amber-400" />
            <span className="text-ink-400">
              Assets {formatBytes(assets)} ({assetPct.toFixed(0)}%)
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg
      className="w-4 h-4 text-amber-400 shrink-0 mt-0.5"
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden
    >
      <path d="M0 2.5A1.5 1.5 0 0 1 1.5 1h13A1.5 1.5 0 0 1 16 2.5v1A1.5 1.5 0 0 1 14.5 5h-13A1.5 1.5 0 0 1 0 3.5ZM1.5 6h13v7.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 1.5 13.5Zm4 1.75a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg
      className="w-4 h-4 text-red-400 shrink-0 mt-0.5"
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden
    >
      <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5ZM11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H2.506a.58.58 0 0 0-.01 0H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1h-.995a.59.59 0 0 0-.01 0H11Zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5h9.916Zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47ZM8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5Z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M5 5.372v.878c0 .192.168.35.375.35h4.25c.207 0 .375-.158.375-.35v-.878a2.25 2.25 0 1 1 1.5 0v.878a1.85 1.85 0 0 1-1.85 1.85h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.1h-1.5A1.85 1.85 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
    </svg>
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
