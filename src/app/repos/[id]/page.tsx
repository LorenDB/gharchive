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
  const [releases, setReleases] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<Tab>('code');
  const [syncError, setSyncError] = useState('');

  const fetchData = useCallback(async () => {
    const [repoRes, releaseRes] = await Promise.all([
      fetch(`/api/repos/${id}`),
      fetch(`/api/repos/${id}/releases`),
    ]);
    if (repoRes.ok) {
      const data = await repoRes.json();
      setRepo(data.repo);
      setSyncLogs(data.syncLogs || []);
    }
    if (releaseRes.ok) {
      const data = await releaseRes.json();
      setReleases(data);
    }
    setLoading(false);
  }, [id]);

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
    return <p className="text-gray-500 text-sm">Loading...</p>;
  }

  if (!repo) {
    return <p className="text-gray-500">Repository not found.</p>;
  }

  const platformColor =
    repo.platform === 'github' ? 'text-gray-300' : 'text-orange-400';

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'code', label: 'Code' },
    { id: 'releases', label: 'Releases', count: releases.length },
    { id: 'activity', label: 'Activity', count: syncLogs.length },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div>
          <button
            onClick={() => router.push('/')}
            className="text-sm text-gray-500 hover:text-gray-300 mb-2"
          >
            &larr; Back
          </button>
          <h1 className="text-xl font-semibold flex items-center gap-2 flex-wrap">
            <span className={platformColor}>
              {repo.platform === 'github' ? 'GH' : 'GL'}
            </span>
            <span className="font-mono">
              {repo.owner}/{repo.name}
            </span>
          </h1>
          <p className="text-sm text-gray-500 mt-1 font-mono break-all">
            {repo.clone_url}
          </p>
          {repo.last_synced_at && (
            <p className="text-xs text-gray-600 mt-2">
              Last synced {formatRelativeTime(repo.last_synced_at)}
              <span className="text-gray-700"> · </span>
              {formatDate(repo.last_synced_at)}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 rounded-lg bg-white text-black font-medium text-sm hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <button
            onClick={handleDelete}
            className="px-4 py-2 rounded-lg border border-red-800 text-red-400 font-medium text-sm hover:bg-red-900/30 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {syncError && (
        <p className="mb-4 text-sm text-red-400">{syncError}</p>
      )}

      {/* Stats */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Branches" value={repo.branch_count ?? '—'} />
        <Stat label="Tags" value={repo.tag_count ?? '—'} />
        <Stat label="Releases" value={releases.length} />
        <Stat
          label="Mirror size"
          value={
            repo.size_bytes != null ? formatBytes(repo.size_bytes) : '—'
          }
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-800 mb-4">
        <nav className="flex gap-1 -mb-px">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-white text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700'
              }`}
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span
                  className={`ml-2 inline-flex items-center justify-center min-w-[1.25rem] px-1.5 py-0.5 rounded-full text-[10px] ${
                    tab === t.id
                      ? 'bg-gray-700 text-gray-200'
                      : 'bg-gray-900 text-gray-500'
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'code' && <RepoTree repoId={String(id)} />}

      {tab === 'releases' && (
        <ReleasesViewer repoId={id} releases={releases} />
      )}

      {tab === 'activity' && (
        <section>
          {syncLogs.length === 0 ? (
            <p className="text-sm text-gray-600">No sync history yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/50">
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Time</th>
                    <th className="px-4 py-2.5">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLogs.map((log: any) => (
                    <tr
                      key={log.id}
                      className="border-b border-gray-800/50 last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            log.status === 'success'
                              ? 'text-green-400'
                              : 'text-red-400'
                          }
                        >
                          {log.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 font-mono text-xs whitespace-nowrap">
                        {formatDate(log.created_at)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400 font-mono text-xs max-w-md truncate">
                        {log.message || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="p-3 rounded-lg border border-gray-800 bg-gray-900/50">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
