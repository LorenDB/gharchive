'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { formatDate } from '@/lib/format';

interface Settings {
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  download_release_assets: boolean;
  max_asset_size_mb: number;
  concurrent_syncs: number;
  auto_scan_stars_enabled: boolean;
  auto_import_stars_enabled: boolean;
  auto_scan_owned_enabled: boolean;
  auto_import_owned_enabled: boolean;
  github_scan_interval_hours: number;
  auto_import_owned_include_forks: boolean;
  auto_import_owned_include_private: boolean;
  memory_aware_enabled: boolean;
  min_free_memory_mb: number;
  max_memory_usage_ratio: number;
  alerts_enabled: boolean;
  apprise_api_url: string;
  apprise_config_key: string;
  apprise_urls: string[];
  apprise_use_tags: boolean;
  alert_new_release: boolean;
  alert_releases_wiped: boolean;
  alert_history_wiped: boolean;
  alert_repo_deleted: boolean;
  alert_sync_failed: boolean;
  alert_storage_low: boolean;
  alert_memory_low: boolean;
  storage_alert_threshold_percent: number;
  storage_alert_min_free_mb: number;
}

interface SchedulerStatus {
  started: boolean;
  running: boolean;
  last_run_at: string | null;
  last_run_summary: string | null;
  last_github_scan_at: string | null;
  last_github_scan_summary: string | null;
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  memory_aware_enabled?: boolean;
  memory_info?: {
    totalMB: number;
    freeMB: number;
    usedMB: number;
    usageRatio: number;
    cgroupLimited: boolean;
    heapUsedMB: number;
  };
  adjusted_concurrency?: number;
  alerts_enabled?: boolean;
  alerts_configured?: boolean;
}

interface DiskInfo {
  path: string;
  totalMB: number;
  freeMB: number;
  usedMB: number;
  usageRatio: number;
  available: boolean;
}

const ALERT_CATEGORY_ROWS: {
  key: keyof Settings;
  label: string;
  description: string;
  group: 'archive' | 'system';
}[] = [
  {
    key: 'alert_new_release',
    label: 'New release',
    description: 'A new release tag was published and archived.',
    group: 'archive',
  },
  {
    key: 'alert_releases_wiped',
    label: 'Releases wiped',
    description: 'Remote releases disappeared (archive had some; upstream now none).',
    group: 'archive',
  },
  {
    key: 'alert_history_wiped',
    label: 'History wiped',
    description: 'Git history force-rewritten or branches/tags mass-deleted upstream.',
    group: 'archive',
  },
  {
    key: 'alert_repo_deleted',
    label: 'Repo deleted',
    description: 'Remote repository is gone or inaccessible (404 / not found).',
    group: 'archive',
  },
  {
    key: 'alert_sync_failed',
    label: 'Sync failed',
    description: 'A repository sync failed for a non-deletion reason.',
    group: 'archive',
  },
  {
    key: 'alert_storage_low',
    label: 'Storage low',
    description: 'DATA_DIR disk usage is high or free space is below the threshold.',
    group: 'system',
  },
  {
    key: 'alert_memory_low',
    label: 'Memory low',
    description: 'System or cgroup memory is critically low; jobs may be deferred.',
    group: 'system',
  },
];

const INTERVAL_LABELS: Record<number, string> = {
  1: 'Every hour',
  6: 'Every 6 hours',
  12: 'Every 12 hours',
  24: 'Daily',
  48: 'Every 2 days',
  168: 'Weekly',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [intervals, setIntervals] = useState<number[]>([1, 6, 12, 24, 48, 168]);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [ghAccount, setGhAccount] = useState<{
    username: string;
    linked_at: string;
    last_stars_import_at: string | null;
    last_stars_scan_at: string | null;
    last_owned_scan_at: string | null;
    last_owned_import_at: string | null;
  } | null>(null);
  const [ghToken, setGhToken] = useState('');
  const [ghBusy, setGhBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState<'stars' | 'owned' | 'both' | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [alertsConfigured, setAlertsConfigured] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [appriseUrlsText, setAppriseUrlsText] = useState('');

  const load = useCallback(async () => {
    try {
      const [res, ghRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/github'),
      ]);
      const data = await res.json();
      setSettings(data.settings);
      setDraft(data.settings);
      setAppriseUrlsText((data.settings?.apprise_urls || []).join('\n'));
      setIntervals(data.interval_options || [1, 6, 12, 24, 48, 168]);
      setScheduler(data.scheduler);
      setDisk(data.disk || null);
      setAlertsConfigured(Boolean(data.alerts?.configured));
      if (ghRes.ok) {
        const gh = await ghRes.json();
        setGhAccount(gh.account);
      }
    } catch {
      setMessage({ type: 'err', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  async function linkGithub(e: React.FormEvent) {
    e.preventDefault();
    setGhBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/github', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ghToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to link');
      setGhAccount(data.account);
      setGhToken('');
      setMessage({
        type: 'ok',
        text: `Linked GitHub as @${data.account.username}`,
      });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setGhBusy(false);
    }
  }

  async function unlinkGithub() {
    if (!confirm('Unlink GitHub account? The token will be removed from local storage.'))
      return;
    setGhBusy(true);
    try {
      await fetch('/api/github', { method: 'DELETE' });
      setGhAccount(null);
      setMessage({ type: 'ok', text: 'GitHub account unlinked' });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setGhBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  const urlsDirty =
    draft != null &&
    appriseUrlsText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean)
      .join('\n') !== (draft.apprise_urls || []).join('\n');

  const dirty =
    (draft &&
      settings &&
      JSON.stringify(draft) !== JSON.stringify(settings)) ||
    urlsDirty;

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        ...draft,
        apprise_urls: appriseUrlsText
          .split(/[\n,]+/)
          .map((u) => u.trim())
          .filter(Boolean),
      };
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSettings(data.settings);
      setDraft(data.settings);
      setAppriseUrlsText((data.settings?.apprise_urls || []).join('\n'));
      setScheduler(data.scheduler);
      setAlertsConfigured(Boolean(data.alerts?.configured));
      setMessage({ type: 'ok', text: 'Settings saved' });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function sendTestAlert() {
    setTestBusy(true);
    setMessage(null);
    try {
      // Persist draft first so the test uses current form values
      if (draft && dirty) {
        const payload = {
          ...draft,
          apprise_urls: appriseUrlsText
            .split(/[\n,]+/)
            .map((u) => u.trim())
            .filter(Boolean),
        };
        const saveRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error || 'Save failed before test');
        setSettings(saveData.settings);
        setDraft(saveData.settings);
        setAppriseUrlsText((saveData.settings?.apprise_urls || []).join('\n'));
        setScheduler(saveData.scheduler);
        setAlertsConfigured(Boolean(saveData.alerts?.configured));
      }

      const res = await fetch('/api/alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'new_release' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test failed');
      setMessage({ type: 'ok', text: data.message || 'Test alert sent' });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setTestBusy(false);
    }
  }

  async function runAllNow() {
    setRunningAll(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, sync: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setScheduler(data.scheduler);
      const sync = data.sync;
      setMessage({
        type: 'ok',
        text: sync?.message || 'Sync finished',
      });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setRunningAll(false);
    }
  }

  async function runGithubScan(kind: 'stars' | 'owned' | 'both') {
    setScanBusy(kind);
    setMessage(null);
    try {
      if (kind === 'both') {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true, sync: false, github_scan: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');
        setScheduler(data.scheduler);
        const msgs = data.github?.messages?.join('; ') || 'Scan finished';
        setMessage({ type: 'ok', text: msgs });
      } else if (kind === 'stars') {
        const res = await fetch('/api/github/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scan: true,
            force_import: draft?.auto_import_stars_enabled ?? false,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Stars scan failed');
        setMessage({ type: 'ok', text: data.result?.message || 'Stars scan done' });
      } else {
        const res = await fetch('/api/github/owned', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scan: true,
            force_import: draft?.auto_import_owned_enabled ?? false,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Owned scan failed');
        setMessage({ type: 'ok', text: data.result?.message || 'Owned scan done' });
      }
      // refresh account timestamps
      const ghRes = await fetch('/api/github');
      if (ghRes.ok) {
        const gh = await ghRes.json();
        setGhAccount(gh.account);
      }
      const setRes = await fetch('/api/settings');
      if (setRes.ok) {
        const s = await setRes.json();
        setScheduler(s.scheduler);
      }
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setScanBusy(null);
    }
  }

  if (loading || !draft) {
    return (
      <div className="flex items-center gap-2 text-ink-500 text-sm">
        <Spinner /> Loading settings…
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Control how often archives update and how release assets are stored.
        </p>
      </div>

      {message && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            message.type === 'ok'
              ? 'border-mint-400/30 bg-mint-400/10 text-mint-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-6">
        {/* GitHub account */}
        <section className="surface p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-1">GitHub account</h2>
          <p className="hint !mt-0 mb-5">
            Link a personal access token to import starred repositories and star lists.
            Token is stored only in local <span className="font-mono">data/db.json</span>.
            Needs classic PAT with <span className="font-mono">read:user</span> for
            stars; add <span className="font-mono">repo</span> to include private
            owned repositories.{' '}
            <a
              href="https://github.com/settings/tokens/new?description=GHArchive&scopes=read:user,repo"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
            >
              Create a classic PAT on GitHub ↗
            </a>
          </p>

          {ghAccount ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="badge-mint">@{ghAccount.username}</span>
                <span className="text-xs text-ink-500">
                  Linked {formatDate(ghAccount.linked_at)}
                </span>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-ink-500">
                <div>
                  Stars scan:{' '}
                  {ghAccount.last_stars_scan_at
                    ? formatDate(ghAccount.last_stars_scan_at)
                    : 'never'}
                </div>
                <div>
                  Owned scan:{' '}
                  {ghAccount.last_owned_scan_at
                    ? formatDate(ghAccount.last_owned_scan_at)
                    : 'never'}
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Link href="/import" className="btn-primary">
                  Import stars
                </Link>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={unlinkGithub}
                  disabled={ghBusy}
                >
                  Unlink
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={linkGithub} className="space-y-3">
              <div>
                <label className="label" htmlFor="gh-token">
                  Personal access token
                </label>
                <input
                  id="gh-token"
                  type="password"
                  className="input font-mono text-[13px]"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  placeholder="ghp_… or github_pat_…"
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                className="btn-primary"
                disabled={ghBusy || !ghToken.trim()}
              >
                {ghBusy ? (
                  <>
                    <Spinner /> Linking…
                  </>
                ) : (
                  'Link account'
                )}
              </button>
            </form>
          )}
        </section>

        {/* GitHub auto-scan / import */}
        <section className="surface p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-1">
            GitHub auto-discovery
          </h2>
          <p className="hint !mt-0 mb-5">
            Periodically scan the linked account for new stars and owned repositories.
            Enable auto-import to mirror anything not yet archived. Requires a linked
            GitHub token.
          </p>

          <div
            className={`space-y-5 ${!ghAccount ? 'opacity-40 pointer-events-none' : ''}`}
          >
            <div>
              <label className="label">Scan frequency</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {intervals.map((h) => {
                  const selected = draft.github_scan_interval_hours === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() =>
                        setDraft({ ...draft, github_scan_interval_hours: h })
                      }
                      className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-all ${
                        selected
                          ? 'border-amber-400/50 bg-amber-400/10 text-amber-300 shadow-glow'
                          : 'border-ink-700 bg-ink-950/50 text-ink-300 hover:border-ink-600'
                      }`}
                    >
                      <span className="block font-medium">
                        {INTERVAL_LABELS[h] || `Every ${h}h`}
                      </span>
                      <span className="block text-[11px] text-ink-500 mt-0.5 font-mono">
                        {h}h
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-ink-100">Scan starred repos</p>
                  <p className="hint !mt-1">
                    Refresh star lists and detect newly starred repositories.
                  </p>
                </div>
                <Toggle
                  checked={draft.auto_scan_stars_enabled}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      auto_scan_stars_enabled: v,
                      ...(v ? {} : { auto_import_stars_enabled: false }),
                    })
                  }
                  label="Scan stars"
                />
              </div>
              <div className="flex items-start justify-between gap-4 pl-0 sm:pl-2">
                <div>
                  <p className="text-sm font-medium text-ink-200">Auto-import new stars</p>
                  <p className="hint !mt-1">
                    Clone and archive stars that are not already in the vault. Also
                    updates list membership for existing mirrors.
                  </p>
                </div>
                <Toggle
                  checked={draft.auto_import_stars_enabled}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      auto_import_stars_enabled: v,
                      ...(v ? { auto_scan_stars_enabled: true } : {}),
                    })
                  }
                  label="Auto-import stars"
                />
              </div>
            </div>

            <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-ink-100">Scan owned repos</p>
                  <p className="hint !mt-1">
                    Discover repositories owned by @{ghAccount?.username || 'you'}{' '}
                    (affiliation=owner).
                  </p>
                </div>
                <Toggle
                  checked={draft.auto_scan_owned_enabled}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      auto_scan_owned_enabled: v,
                      ...(v ? {} : { auto_import_owned_enabled: false }),
                    })
                  }
                  label="Scan owned"
                />
              </div>
              <div className="flex items-start justify-between gap-4 pl-0 sm:pl-2">
                <div>
                  <p className="text-sm font-medium text-ink-200">Auto-import owned</p>
                  <p className="hint !mt-1">
                    Mirror owned repos not yet archived. Tagged with an{' '}
                    <span className="font-mono">Owned</span> list.
                  </p>
                </div>
                <Toggle
                  checked={draft.auto_import_owned_enabled}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      auto_import_owned_enabled: v,
                      ...(v ? { auto_scan_owned_enabled: true } : {}),
                    })
                  }
                  label="Auto-import owned"
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-4 pt-1 border-t border-ink-800/80">
                <label className="flex items-center gap-2 text-sm text-ink-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-ink-600 bg-ink-950 text-amber-400"
                    checked={draft.auto_import_owned_include_forks}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        auto_import_owned_include_forks: e.target.checked,
                      })
                    }
                  />
                  Include forks
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-ink-600 bg-ink-950 text-amber-400"
                    checked={draft.auto_import_owned_include_private}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        auto_import_owned_include_private: e.target.checked,
                      })
                    }
                  />
                  Include private
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="btn-secondary"
                disabled={!ghAccount || scanBusy !== null}
                onClick={() => runGithubScan('stars')}
              >
                {scanBusy === 'stars' ? (
                  <>
                    <Spinner /> Scanning stars…
                  </>
                ) : (
                  'Scan stars now'
                )}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!ghAccount || scanBusy !== null}
                onClick={() => runGithubScan('owned')}
              >
                {scanBusy === 'owned' ? (
                  <>
                    <Spinner /> Scanning owned…
                  </>
                ) : (
                  'Scan owned now'
                )}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!ghAccount || scanBusy !== null}
                onClick={() => runGithubScan('both')}
              >
                {scanBusy === 'both' ? (
                  <>
                    <Spinner /> Scanning…
                  </>
                ) : (
                  'Scan all now'
                )}
              </button>
            </div>
            {!ghAccount && (
              <p className="hint">Link a GitHub account above to enable discovery.</p>
            )}
          </div>
        </section>

        {/* Auto-sync */}
        <section className="surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">Archive updates</h2>
              <p className="hint !mt-1">
                Automatically re-fetch git mirrors and releases on a schedule.
              </p>
            </div>
            <Toggle
              checked={draft.auto_sync_enabled}
              onChange={(v) => setDraft({ ...draft, auto_sync_enabled: v })}
              label="Enable auto-sync"
            />
          </div>

          <div
            className={`space-y-5 transition-opacity ${
              draft.auto_sync_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            }`}
          >
            <div>
              <label className="label" htmlFor="interval">
                Sync frequency
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {intervals.map((h) => {
                  const selected = draft.sync_interval_hours === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => setDraft({ ...draft, sync_interval_hours: h })}
                      className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-all ${
                        selected
                          ? 'border-amber-400/50 bg-amber-400/10 text-amber-300 shadow-glow'
                          : 'border-ink-700 bg-ink-950/50 text-ink-300 hover:border-ink-600'
                      }`}
                    >
                      <span className="block font-medium">
                        {INTERVAL_LABELS[h] || `Every ${h}h`}
                      </span>
                      <span className="block text-[11px] text-ink-500 mt-0.5 font-mono">
                        {h}h
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="hint">
                Each repository is only re-synced once its last sync is older than this
                interval.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="concurrent">
                Concurrent syncs
              </label>
              <select
                id="concurrent"
                className="input max-w-[12rem]"
                value={draft.concurrent_syncs}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    concurrent_syncs: parseInt(e.target.value, 10),
                  })
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </select>
              <p className="hint">
                Higher values finish large archives faster but use more disk and network.
              </p>
            </div>
          </div>
        </section>

        {/* Releases */}
        <section className="surface p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-1">Release assets</h2>
          <p className="hint !mt-0 mb-5">
            Control whether binary assets from GitHub/GitLab releases are stored locally.
          </p>

          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <p className="text-sm font-medium text-ink-200">Download assets</p>
              <p className="hint !mt-1">
                When off, release metadata is still archived but files are not downloaded.
              </p>
            </div>
            <Toggle
              checked={draft.download_release_assets}
              onChange={(v) => setDraft({ ...draft, download_release_assets: v })}
              label="Download release assets"
            />
          </div>

          <div
            className={
              draft.download_release_assets ? '' : 'opacity-40 pointer-events-none'
            }
          >
            <label className="label" htmlFor="max-asset">
              Max asset size (MB)
            </label>
            <input
              id="max-asset"
              type="number"
              min={0}
              className="input max-w-[12rem]"
              value={draft.max_asset_size_mb}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  max_asset_size_mb: Math.max(0, parseInt(e.target.value || '0', 10)),
                })
              }
            />
            <p className="hint">
              Assets larger than this are skipped. Use <span className="font-mono">0</span>{' '}
              for no limit.
            </p>
          </div>
        </section>

        {/* Memory awareness */}
        <section className="surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">Memory limits</h2>
              <p className="hint !mt-1">
                Dynamically adjust job concurrency and defer heavy operations when system
                memory is low.
              </p>
            </div>
            <Toggle
              checked={draft.memory_aware_enabled}
              onChange={(v) => setDraft({ ...draft, memory_aware_enabled: v })}
              label="Enable memory-aware scheduling"
            />
          </div>

          <div
            className={`space-y-5 transition-opacity ${
              draft.memory_aware_enabled
                ? 'opacity-100'
                : 'opacity-40 pointer-events-none'
            }`}
          >
            <div>
              <label className="label" htmlFor="min-free-memory">
                Minimum free memory (MB)
              </label>
              <input
                id="min-free-memory"
                type="number"
                min={64}
                max={65536}
                step={64}
                className="input max-w-[12rem]"
                value={draft.min_free_memory_mb}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    min_free_memory_mb: Math.max(
                      64,
                      parseInt(e.target.value || '256', 10)
                    ),
                  })
                }
              />
              <p className="hint">
                New jobs are deferred when free memory drops below this threshold.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="max-memory-ratio">
                Max memory usage ratio
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="max-memory-ratio"
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.05}
                  className="w-48"
                  value={draft.max_memory_usage_ratio}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      max_memory_usage_ratio: parseFloat(e.target.value),
                    })
                  }
                />
                <span className="font-mono text-sm text-ink-300 tabular-nums w-10">
                  {Math.round(draft.max_memory_usage_ratio * 100)}%
                </span>
              </div>
              <p className="hint">
                Jobs are paused when total memory usage exceeds this fraction of
                available RAM (including cgroup limits in Docker).
              </p>
            </div>

            {scheduler?.memory_info && (
              <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4">
                <p className="text-xs text-ink-500 mb-2 uppercase tracking-wide">
                  Current memory
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-ink-500">Total</span>
                    <br />
                    <span className="font-mono tabular-nums">
                      {scheduler.memory_info.totalMB} MB
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-500">Free</span>
                    <br />
                    <span className="font-mono tabular-nums">
                      {scheduler.memory_info.freeMB} MB
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-500">Heap</span>
                    <br />
                    <span className="font-mono tabular-nums">
                      {scheduler.memory_info.heapUsedMB} MB
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-500">Effective concurrency</span>
                    <br />
                    <span className="font-mono tabular-nums">
                      {scheduler.adjusted_concurrency ?? draft.concurrent_syncs}
                    </span>
                  </div>
                </div>
                {scheduler.memory_info.cgroupLimited && (
                  <p className="text-xs text-amber-400/70 mt-2">
                    Running under a cgroup memory limit (Docker/container).
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Alerts / Apprise */}
        <section className="surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">Alerts (Apprise)</h2>
              <p className="hint !mt-1">
                Notify Discord, Telegram, email, and{' '}
                <a
                  href="https://github.com/caronc/apprise#supported-notifications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                >
                  100+ other services
                </a>{' '}
                via an{' '}
                <a
                  href="https://github.com/caronc/apprise-api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                >
                  Apprise API
                </a>{' '}
                instance when major archive or system events occur.
              </p>
            </div>
            <Toggle
              checked={draft.alerts_enabled}
              onChange={(v) => setDraft({ ...draft, alerts_enabled: v })}
              label="Enable alerts"
            />
          </div>

          <div
            className={`space-y-5 transition-opacity ${
              draft.alerts_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
            }`}
          >
            <div>
              <label className="label" htmlFor="apprise-api-url">
                Apprise API URL
              </label>
              <input
                id="apprise-api-url"
                type="url"
                className="input font-mono text-[13px]"
                value={draft.apprise_api_url}
                onChange={(e) =>
                  setDraft({ ...draft, apprise_api_url: e.target.value })
                }
                placeholder="http://apprise:8000"
                autoComplete="off"
              />
              <p className="hint">
                Base URL of your Apprise API container (no trailing path). Example:{' '}
                <span className="font-mono">http://apprise:8000</span>
              </p>
            </div>

            <div>
              <label className="label" htmlFor="apprise-config-key">
                Config key (optional)
              </label>
              <input
                id="apprise-config-key"
                type="text"
                className="input font-mono text-[13px] max-w-xs"
                value={draft.apprise_config_key}
                onChange={(e) =>
                  setDraft({ ...draft, apprise_config_key: e.target.value })
                }
                placeholder="apprise"
                autoComplete="off"
              />
              <p className="hint">
                When set, notifications go to{' '}
                <span className="font-mono">/notify/&#123;key&#125;</span> using URLs
                stored in Apprise. Leave empty to use stateless mode with the URLs
                below.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="apprise-urls">
                Apprise URLs (stateless)
              </label>
              <textarea
                id="apprise-urls"
                className="input font-mono text-[13px] min-h-[5.5rem] resize-y"
                value={appriseUrlsText}
                onChange={(e) => setAppriseUrlsText(e.target.value)}
                placeholder={
                  'discord://webhook_id/webhook_token\ntgram://bottoken/ChatID\nmailto://user:pass@smtp.example.com'
                }
                spellCheck={false}
              />
              <p className="hint">
                One URL per line. Used when no config key is set. See{' '}
                <a
                  href="https://github.com/caronc/apprise/wiki"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                >
                  Apprise wiki
                </a>{' '}
                for URL formats.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink-200">Use category tags</p>
                <p className="hint !mt-1">
                  Pass the alert category as an Apprise <span className="font-mono">tag</span>{' '}
                  so destinations can be filtered (e.g. only critical events to PagerDuty).
                  Tag names match the category ids below (
                  <span className="font-mono">new_release</span>,{' '}
                  <span className="font-mono">storage_low</span>, …).
                </p>
              </div>
              <Toggle
                checked={draft.apprise_use_tags}
                onChange={(v) => setDraft({ ...draft, apprise_use_tags: v })}
                label="Use Apprise tags"
              />
            </div>

            <div>
              <p className="label mb-2">Archive events</p>
              <div className="rounded-lg border border-ink-800 bg-ink-950/40 divide-y divide-ink-800/80">
                {ALERT_CATEGORY_ROWS.filter((r) => r.group === 'archive').map((row) => (
                  <div
                    key={row.key}
                    className="flex items-start justify-between gap-4 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-ink-100">{row.label}</p>
                      <p className="hint !mt-0.5">{row.description}</p>
                      <p className="text-[11px] font-mono text-ink-600 mt-0.5">
                        tag: {row.key.replace(/^alert_/, '')}
                      </p>
                    </div>
                    <Toggle
                      checked={Boolean(draft[row.key])}
                      onChange={(v) => setDraft({ ...draft, [row.key]: v })}
                      label={row.label}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="label mb-2">System events</p>
              <div className="rounded-lg border border-ink-800 bg-ink-950/40 divide-y divide-ink-800/80">
                {ALERT_CATEGORY_ROWS.filter((r) => r.group === 'system').map((row) => (
                  <div
                    key={row.key}
                    className="flex items-start justify-between gap-4 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-ink-100">{row.label}</p>
                      <p className="hint !mt-0.5">{row.description}</p>
                      <p className="text-[11px] font-mono text-ink-600 mt-0.5">
                        tag: {row.key.replace(/^alert_/, '')}
                      </p>
                    </div>
                    <Toggle
                      checked={Boolean(draft[row.key])}
                      onChange={(v) => setDraft({ ...draft, [row.key]: v })}
                      label={row.label}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div
              className={`space-y-4 ${
                draft.alert_storage_low ? '' : 'opacity-40 pointer-events-none'
              }`}
            >
              <p className="label !mb-0">Storage thresholds</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label" htmlFor="storage-threshold">
                    Usage threshold (%)
                  </label>
                  <input
                    id="storage-threshold"
                    type="number"
                    min={50}
                    max={100}
                    className="input max-w-[10rem]"
                    value={draft.storage_alert_threshold_percent}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        storage_alert_threshold_percent: Math.min(
                          100,
                          Math.max(50, parseInt(e.target.value || '90', 10))
                        ),
                      })
                    }
                  />
                  <p className="hint">Alert when used space reaches this percent.</p>
                </div>
                <div>
                  <label className="label" htmlFor="storage-min-free">
                    Min free (MB)
                  </label>
                  <input
                    id="storage-min-free"
                    type="number"
                    min={0}
                    step={128}
                    className="input max-w-[10rem]"
                    value={draft.storage_alert_min_free_mb}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        storage_alert_min_free_mb: Math.max(
                          0,
                          parseInt(e.target.value || '0', 10)
                        ),
                      })
                    }
                  />
                  <p className="hint">
                    Also alert when free space drops below this (0 = ignore).
                  </p>
                </div>
              </div>

              {disk?.available && (
                <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-4">
                  <p className="text-xs text-ink-500 mb-2 uppercase tracking-wide">
                    Current disk ({disk.path})
                  </p>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <span className="text-ink-500">Used</span>
                      <br />
                      <span className="font-mono tabular-nums">
                        {disk.usedMB} MB ({Math.round(disk.usageRatio * 100)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-ink-500">Free</span>
                      <br />
                      <span className="font-mono tabular-nums">{disk.freeMB} MB</span>
                    </div>
                    <div>
                      <span className="text-ink-500">Total</span>
                      <br />
                      <span className="font-mono tabular-nums">{disk.totalMB} MB</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                className="btn-secondary"
                onClick={sendTestAlert}
                disabled={testBusy || !draft.alerts_enabled}
              >
                {testBusy ? (
                  <>
                    <Spinner /> Sending test…
                  </>
                ) : (
                  'Send test notification'
                )}
              </button>
              <span className="text-xs text-ink-500">
                {alertsConfigured ||
                (draft.apprise_api_url.trim() &&
                  (draft.apprise_config_key.trim() ||
                    appriseUrlsText.trim())) ? (
                  <span className="text-mint-400">Apprise looks configured</span>
                ) : (
                  'Save API URL + config key or URLs, then test'
                )}
              </span>
            </div>
          </div>
        </section>

        {/* Scheduler status */}
        <section className="surface p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white mb-4">Scheduler status</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <StatusRow
              label="Process"
              value={
                scheduler?.started ? (
                  <span className="text-mint-400">running</span>
                ) : (
                  <span className="text-ink-500">not started</span>
                )
              }
            />
            <StatusRow
              label="Current job"
              value={
                scheduler?.running ? (
                  <span className="text-amber-300">syncing…</span>
                ) : (
                  <span className="text-ink-400">idle</span>
                )
              }
            />
            <StatusRow
              label="Last run"
              value={
                scheduler?.last_run_at ? (
                  <span className="font-mono text-xs">
                    {formatDate(scheduler.last_run_at)}
                  </span>
                ) : (
                  <span className="text-ink-500">never</span>
                )
              }
            />
            <StatusRow
              label="Last result"
              value={
                <span className="text-ink-400 text-xs">
                  {scheduler?.last_run_summary || '—'}
                </span>
              }
            />
            <StatusRow
              label="Last GitHub scan"
              value={
                scheduler?.last_github_scan_at ? (
                  <span className="font-mono text-xs">
                    {formatDate(scheduler.last_github_scan_at)}
                  </span>
                ) : (
                  <span className="text-ink-500">never</span>
                )
              }
            />
            <StatusRow
              label="GitHub scan result"
              value={
                <span className="text-ink-400 text-xs">
                  {scheduler?.last_github_scan_summary || '—'}
                </span>
              }
            />
          </dl>

          <div className="mt-5 pt-5 border-t border-ink-800">
            <button
              type="button"
              className="btn-secondary"
              onClick={runAllNow}
              disabled={runningAll || scheduler?.running}
            >
              {runningAll || scheduler?.running ? (
                <>
                  <Spinner /> Syncing all repos…
                </>
              ) : (
                'Sync all repositories now'
              )}
            </button>
            <p className="hint">
              Forces a full pass over every archived repository, ignoring the interval.
            </p>
          </div>
        </section>

        {/* Save bar */}
        <div className="flex items-center justify-between gap-3 sticky bottom-4 surface px-4 py-3">
          <p className="text-xs text-ink-500">
            {dirty ? 'You have unsaved changes' : 'All changes saved'}
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? (
              <>
                <Spinner /> Saving…
              </>
            ) : (
              'Save settings'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-amber-400' : 'bg-ink-700'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function StatusRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-ink-800/80 bg-ink-950/40 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-ink-500 mb-0.5">
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
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
  );
}
