'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatBytes, formatDate, formatDiskSize } from '@/lib/format';

interface Settings {
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  download_release_assets: boolean;
  max_asset_size_mb: number;
  concurrent_syncs: number;
  auto_scan_stars_enabled: boolean;
  auto_import_stars_enabled: boolean;
  auto_import_stars_list_ids: string[];
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
  apprise_endpoint_url: string;
  apprise_config_key: string;
  apprise_urls: string[];
  apprise_use_tags: boolean;
  alert_new_release: boolean;
  alert_releases_wiped: boolean;
  alert_history_wiped: boolean;
  alert_repo_deleted: boolean;
  alert_repo_archived: boolean;
  alert_sync_failed: boolean;
  alert_storage_low: boolean;
  alert_memory_low: boolean;
  storage_alert_threshold_percent: number;
  storage_alert_min_free_mb: number;
  global_max_asset_size_mb: number;
  approved_asset_hosts: string[];
  rejected_asset_hosts: string[];
  wayback_readme_urls_enabled: boolean;
  wayback_access_key: string;
  wayback_secret_key: string;
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

interface UserUsageSummary {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  created_at: string | null;
  last_login_at: string | null;
  registered: boolean;
  repo_count: number;
  private_repo_count: number;
  storage_bytes: number;
}

interface RepoStorageEntry {
  repo_id: number;
  archive_id: number;
  platform: string;
  owner: string;
  name: string;
  is_private: boolean;
  total_bytes: number;
  mirror_bytes: number;
  asset_bytes: number;
  attributed_bytes: number;
  member_count: number;
}

interface UserStorageDetail {
  total_bytes: number;
  repo_count: number;
  private_repo_count: number;
  largest_repos: RepoStorageEntry[];
  other_bytes: number;
  other_repo_count: number;
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
    key: 'alert_repo_archived',
    label: 'Repo archived',
    description: 'Remote repository was marked as archived on GitHub/GitLab.',
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

type SettingsTab = 'settings' | 'admin';

type InitialSettingsData = {
  settings: Settings;
  interval_options: number[];
  scheduler: SchedulerStatus;
  disk: DiskInfo | null;
  alerts_configured: boolean;
  is_admin: boolean;
  github_account: {
    username: string;
    linked_at: string;
    last_stars_import_at: string | null;
    last_stars_scan_at: string | null;
    last_owned_scan_at: string | null;
    last_owned_import_at: string | null;
  } | null;
  lists: { id: number; name: string; github_list_id: string | null }[];
  users: UserUsageSummary[] | null;
  storage: UserStorageDetail;
};

export default function SettingsClient({
  initial,
}: {
  initial: InitialSettingsData;
}) {
  const [settings, setSettings] = useState<Settings | null>(initial.settings);
  const [draft, setDraft] = useState<Settings | null>(initial.settings);
  const [intervals, setIntervals] = useState<number[]>(
    initial.interval_options?.length
      ? initial.interval_options
      : [1, 6, 12, 24, 48, 168]
  );
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(
    initial.scheduler
  );
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
  } | null>(initial.github_account);
  const [ghToken, setGhToken] = useState('');
  const [ghBusy, setGhBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState<'stars' | 'owned' | 'both' | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(initial.disk);
  const [alertsConfigured, setAlertsConfigured] = useState(
    initial.alerts_configured
  );
  const [testBusy, setTestBusy] = useState(false);
  const [appriseUrlsText, setAppriseUrlsText] = useState(
    (initial.settings?.apprise_urls || []).join('\n')
  );
  const [isAdmin, setIsAdmin] = useState(initial.is_admin);
  const [ghLists, setGhLists] = useState<{ id: number; name: string; github_list_id: string | null }[]>(
    initial.lists
  );
  const [approvedHosts, setApprovedHosts] = useState<string[]>(
    initial.settings?.approved_asset_hosts || []
  );
  const [rejectedHosts, setRejectedHosts] = useState<string[]>(
    initial.settings?.rejected_asset_hosts || []
  );
  const [hostBusy, setHostBusy] = useState<string | null>(null);
  const [users, setUsers] = useState<UserUsageSummary[] | null>(initial.users);
  const [storage, setStorage] = useState<UserStorageDetail>(
    initial.storage || {
      total_bytes: 0,
      repo_count: 0,
      private_repo_count: 0,
      largest_repos: [],
      other_bytes: 0,
      other_repo_count: 0,
    }
  );
  const [tab, setTab] = useState<SettingsTab>('settings');

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
    setMessage(null);
    try {
      const res = await fetch('/api/github', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to unlink');
      setGhAccount(null);
      setMessage({ type: 'ok', text: 'GitHub account unlinked' });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setGhBusy(false);
    }
  }

  async function revokeHost(hostname: string) {
    setHostBusy(hostname);
    setMessage(null);
    try {
      const res = await fetch('/api/asset-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', hostname }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to revoke');
      const approved = Array.isArray(data.approved) ? data.approved : [];
      const rejected = Array.isArray(data.rejected) ? data.rejected : [];
      setApprovedHosts(approved);
      setRejectedHosts(rejected);
      setDraft((d) =>
        d
          ? {
              ...d,
              approved_asset_hosts: approved,
              rejected_asset_hosts: rejected,
            }
          : d
      );
      setSettings((s) =>
        s
          ? {
              ...s,
              approved_asset_hosts: approved,
              rejected_asset_hosts: rejected,
            }
          : s
      );
      setMessage({ type: 'ok', text: `Removed domain ${hostname}` });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setHostBusy(null);
    }
  }

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
      setIsAdmin(Boolean(data.is_admin));
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
        setIsAdmin(Boolean(saveData.is_admin));
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
      const ghRes = await fetch('/api/github');
      if (ghRes.ok) {
        const gh = await ghRes.json();
        setGhAccount(gh.account);
      }
      const setRes = await fetch('/api/settings');
      if (setRes.ok) {
        const s = await setRes.json();
        setScheduler(s.scheduler);
        if (Array.isArray(s.users)) setUsers(s.users);
        if (s.disk) setDisk(s.disk);
        if (s.storage) setStorage(s.storage);
      }
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setScanBusy(null);
    }
  }

  async function refreshAdminData() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const s = await res.json();
      if (Array.isArray(s.users)) setUsers(s.users);
      if (s.disk) setDisk(s.disk);
      if (s.storage) setStorage(s.storage);
    } catch {
      // ignore refresh errors
    }
  }

  if (!draft) {
    return (
      <div className="flex items-center gap-2 text-ink-500 text-sm">
        <Spinner /> Loading settings…
      </div>
    );
  }

  const totalUserStorage = (users || []).reduce((sum, u) => sum + u.storage_bytes, 0);
  const activeTab: SettingsTab = isAdmin ? tab : 'settings';

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Control how often archives update and how release assets are stored.
        </p>
      </div>

      {isAdmin && (
        <div className="border-b border-ink-800 mb-6">
          <nav className="flex items-center gap-1 -mb-px overflow-x-auto" aria-label="Settings sections">
            {(
              [
                { id: 'settings' as const, label: 'Settings' },
                { id: 'admin' as const, label: 'Admin' },
              ] as const
            ).map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={active ? 'tab-btn-active' : 'tab-btn-idle'}
                >
                  <span className="leading-none">{t.label}</span>
                  {active && (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-amber-400" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      )}

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
        {activeTab === 'settings' && (
          <>
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
                  {draft.auto_import_stars_enabled && ghLists.filter(l => l.github_list_id).length > 0 && (
                    <div className="pt-2 border-t border-ink-800/80 pl-0 sm:pl-2">
                      <p className="text-xs text-ink-400 mb-2">
                        Only auto-import stars in selected lists (select none to import all):
                      </p>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {ghLists.filter(l => l.github_list_id).map((list) => {
                          const checked = (draft.auto_import_stars_list_ids || []).includes(list.github_list_id!);
                          return (
                            <label
                              key={list.id}
                              className="flex items-center gap-2 text-sm text-ink-300 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                className="rounded border-ink-600 bg-ink-950 text-amber-400"
                                checked={checked}
                                onChange={() => {
                                  const ids = draft.auto_import_stars_list_ids || [];
                                  setDraft({
                                    ...draft,
                                    auto_import_stars_list_ids: checked
                                      ? ids.filter(id => id !== list.github_list_id)
                                      : [...ids, list.github_list_id!],
                                  });
                                }}
                              />
                              {list.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
              </div>
            </section>

            {/* Releases */}
            <section className="surface p-5 sm:p-6">
              <h2 className="text-base font-semibold text-white mb-1">Release assets</h2>
              <p className="hint !mt-0 mb-5">
                Control whether binary assets from GitHub, GitLab, Codeberg, or other
                release hosts are stored locally.
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
                  Assets larger than this are skipped. Use{' '}
                  <span className="font-mono">0</span>{' '}
                  for no limit.
                  {draft.global_max_asset_size_mb > 0 && (
                    <>
                      {' '}Global cap:{' '}
                      <span className="font-mono">{draft.global_max_asset_size_mb} MB</span>
                    </>
                  )}
                </p>

                <div className="mt-6 pt-5 border-t border-ink-800/80">
                  <h3 className="text-sm font-medium text-ink-200 mb-1">
                    Extra download domains
                  </h3>
                  <p className="hint !mt-0 mb-4">
                    When a Forgejo (or similar) host serves release assets from a
                    different domain, you&apos;ll get a popup to approve or reject
                    it. Manage those decisions here.
                  </p>

                  {approvedHosts.length === 0 && rejectedHosts.length === 0 ? (
                    <p className="text-xs text-ink-500">
                      No approved or rejected domains yet.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {approvedHosts.length > 0 && (
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-2">
                            Approved
                          </p>
                          <ul className="space-y-1.5">
                            {approvedHosts.map((h) => (
                              <li
                                key={h}
                                className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"
                              >
                                <span className="font-mono text-sm text-mint-400 break-all">
                                  {h}
                                </span>
                                <button
                                  type="button"
                                  className="btn-ghost !py-1 !px-2 text-xs shrink-0"
                                  disabled={hostBusy === h}
                                  onClick={() => revokeHost(h)}
                                >
                                  {hostBusy === h ? '…' : 'Revoke'}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {rejectedHosts.length > 0 && (
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-2">
                            Rejected
                          </p>
                          <ul className="space-y-1.5">
                            {rejectedHosts.map((h) => (
                              <li
                                key={h}
                                className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2"
                              >
                                <span className="font-mono text-sm text-ink-400 break-all">
                                  {h}
                                </span>
                                <button
                                  type="button"
                                  className="btn-ghost !py-1 !px-2 text-xs shrink-0"
                                  disabled={hostBusy === h}
                                  onClick={() => revokeHost(h)}
                                >
                                  {hostBusy === h ? '…' : 'Revoke'}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Wayback Machine — README URLs */}
            <section className="surface p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    Wayback Machine
                  </h2>
                  <p className="hint !mt-1">
                    During each repo sync, extract absolute{' '}
                    <span className="font-mono">http(s)</span> URLs from the
                    README and submit them to the Internet Archive{' '}
                    <a
                      href="https://web.archive.org/save"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                    >
                      Save Page Now
                    </a>{' '}
                    API for public web archival. Off by default. Requires free{' '}
                    <a
                      href="https://archive.org/account/s3.php"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                    >
                      archive.org S3 API keys
                    </a>
                    .
                  </p>
                </div>
                <Toggle
                  checked={draft.wayback_readme_urls_enabled}
                  onChange={(v) =>
                    setDraft({ ...draft, wayback_readme_urls_enabled: v })
                  }
                  label="Archive README URLs"
                />
              </div>

              <div
                className={`space-y-4 transition-opacity ${
                  draft.wayback_readme_urls_enabled
                    ? 'opacity-100'
                    : 'opacity-40 pointer-events-none'
                }`}
              >
                <div>
                  <label className="label" htmlFor="wayback-access-key">
                    Access key
                  </label>
                  <input
                    id="wayback-access-key"
                    type="password"
                    className="input font-mono text-[13px]"
                    value={draft.wayback_access_key || ''}
                    onChange={(e) =>
                      setDraft({ ...draft, wayback_access_key: e.target.value })
                    }
                    placeholder="S3 access key"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="wayback-secret-key">
                    Secret key
                  </label>
                  <input
                    id="wayback-secret-key"
                    type="password"
                    className="input font-mono text-[13px]"
                    value={draft.wayback_secret_key || ''}
                    onChange={(e) =>
                      setDraft({ ...draft, wayback_secret_key: e.target.value })
                    }
                    placeholder="S3 secret key"
                    autoComplete="off"
                  />
                </div>
                <p className="hint !mt-0">
                  Keys are stored only in local{' '}
                  <span className="font-mono">data/db.json</span> (per user).
                  URLs already captured within the last 30 days are skipped.
                  At most 50 URLs are submitted per repo per sync. Captures are
                  public on the Wayback Machine.
                </p>
                {draft.wayback_readme_urls_enabled &&
                  !(draft.wayback_access_key || '').trim() && (
                    <p className="text-xs text-amber-400/90">
                      Enable is on, but access key is empty — set both keys and
                      save, or archiving will be skipped at sync time.
                    </p>
                  )}
              </div>
            </section>

            {/* Alerts / Apprise — user-facing */}
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
                    instance when major archive events occur.
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
                      isAdmin
                        ? 'Set Apprise API URL on the Admin tab, plus config key or URLs'
                        : 'Save config key or URLs (API URL set by admin), then test'
                    )}
                  </span>
                </div>
              </div>
            </section>

            {/* Storage usage (current user) */}
            <section className="surface p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-1">
                <div>
                  <h2 className="text-base font-semibold text-white">Storage usage</h2>
                  <p className="hint !mt-1">
                    Space attributed to your archives. Shared public mirrors are split
                    evenly among members who archive them.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !px-3 text-xs shrink-0"
                  onClick={refreshAdminData}
                >
                  Refresh
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-0.5">
                    Total
                  </p>
                  <p className="font-mono tabular-nums text-ink-100">
                    {formatBytes(storage.total_bytes)}
                  </p>
                </div>
                <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-0.5">
                    Repos
                  </p>
                  <p className="font-mono tabular-nums text-ink-100">
                    {storage.repo_count}
                    {storage.private_repo_count > 0 && (
                      <span className="text-ink-500 text-xs font-sans ml-1">
                        ({storage.private_repo_count} private)
                      </span>
                    )}
                  </p>
                </div>
                {storage.largest_repos.length > 0 && storage.total_bytes > 0 && (
                  <div className="rounded-lg border border-ink-800 bg-ink-950/40 px-3 py-2.5 col-span-2 sm:col-span-1">
                    <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-0.5">
                      Largest share
                    </p>
                    <p className="font-mono tabular-nums text-ink-100">
                      {Math.round(
                        (storage.largest_repos[0]!.attributed_bytes /
                          storage.total_bytes) *
                          100
                      )}
                      %
                    </p>
                  </div>
                )}
              </div>

              {storage.repo_count === 0 ? (
                <p className="text-sm text-ink-500 mt-4">
                  No archives yet — add a repository to start using storage.
                </p>
              ) : (
                <div className="mt-5">
                  <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-2">
                    Largest repositories
                  </p>
                  <ul className="rounded-lg border border-ink-800 bg-ink-950/40 divide-y divide-ink-800/80">
                    {storage.largest_repos.map((repo) => {
                      const pct =
                        storage.total_bytes > 0
                          ? Math.round(
                              (repo.attributed_bytes / storage.total_bytes) * 100
                            )
                          : 0;
                      return (
                        <li key={repo.repo_id} className="px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <Link
                                href={`/repos/${repo.repo_id}`}
                                className="text-sm font-medium text-ink-100 hover:text-amber-300 truncate block"
                              >
                                {repo.owner}/{repo.name}
                              </Link>
                              <p className="text-[11px] text-ink-500 mt-0.5">
                                <span className="font-mono">{repo.platform}</span>
                                {repo.is_private && (
                                  <span className="ml-1.5 text-ink-600">private</span>
                                )}
                                {repo.member_count > 1 && (
                                  <span className="ml-1.5">
                                    shared ×{repo.member_count}
                                  </span>
                                )}
                                {(repo.mirror_bytes > 0 || repo.asset_bytes > 0) && (
                                  <span className="ml-1.5 text-ink-600">
                                    mirror {formatBytes(repo.mirror_bytes)}
                                    {repo.asset_bytes > 0 && (
                                      <> · assets {formatBytes(repo.asset_bytes)}</>
                                    )}
                                  </span>
                                )}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-mono tabular-nums text-sm text-ink-200">
                                {formatBytes(repo.attributed_bytes)}
                              </p>
                              <p className="text-[11px] text-ink-600 tabular-nums">
                                {pct}%
                                {repo.member_count > 1 &&
                                  repo.total_bytes !== repo.attributed_bytes && (
                                    <span className="ml-1">
                                      of {formatBytes(repo.total_bytes)}
                                    </span>
                                  )}
                              </p>
                            </div>
                          </div>
                          {storage.total_bytes > 0 && (
                            <div className="mt-2 h-1 rounded-full bg-ink-800 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-amber-400/70"
                                style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                    {storage.other_repo_count > 0 && (
                      <li className="px-3 py-2.5 flex items-center justify-between gap-3 text-sm text-ink-500">
                        <span>
                          {storage.other_repo_count} other repo
                          {storage.other_repo_count === 1 ? '' : 's'}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatBytes(storage.other_bytes)}
                        </span>
                      </li>
                    )}
                  </ul>
                </div>
              )}
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
          </>
        )}

        {activeTab === 'admin' && isAdmin && (
          <>
            {/* Instance limits */}
            <section className="surface p-5 sm:p-6">
              <h2 className="text-base font-semibold text-white mb-1">Instance limits</h2>
              <p className="hint !mt-0 mb-5">
                Server-wide knobs that affect sync concurrency and asset downloads for all users.
              </p>

              <div className="space-y-5">
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
                    {scheduler?.adjusted_concurrency != null &&
                      scheduler.adjusted_concurrency !== draft.concurrent_syncs && (
                        <>
                          {' '}Effective now:{' '}
                          <span className="font-mono">
                            {scheduler.adjusted_concurrency}
                          </span>{' '}
                          (memory-adjusted).
                        </>
                      )}
                  </p>
                </div>

                <div>
                  <label className="label" htmlFor="global-max-asset">
                    Global max asset size (MB)
                  </label>
                  <input
                    id="global-max-asset"
                    type="number"
                    min={0}
                    className="input max-w-[12rem]"
                    value={draft.global_max_asset_size_mb}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        global_max_asset_size_mb: Math.max(
                          0,
                          parseInt(e.target.value || '0', 10)
                        ),
                      })
                    }
                  />
                  <p className="hint">
                    Upper bound for all users&rsquo; per-user asset size limits.{' '}
                    <span className="font-mono">0</span> = no global limit.
                  </p>
                </div>
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

            {/* Apprise API + system alerts */}
            <section className="surface p-5 sm:p-6">
              <h2 className="text-base font-semibold text-white mb-1">
                Alerts — server configuration
              </h2>
              <p className="hint !mt-0 mb-5">
                Apprise API base URL (SSRF-sensitive) and system-wide health alert thresholds.
                Per-user notification destinations live on the Settings tab.
              </p>

              <div className="space-y-5">
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
                    <span className="font-mono">http://apprise:8000</span>. Can also be set
                    via env <span className="font-mono">APPRISE_API_URL</span>.
                  </p>
                </div>

                <div>
                  <label className="label" htmlFor="apprise-endpoint-url">
                    Custom endpoint URL
                  </label>
                  <input
                    id="apprise-endpoint-url"
                    type="url"
                    className="input font-mono text-[13px]"
                    value={draft.apprise_endpoint_url}
                    onChange={(e) =>
                      setDraft({ ...draft, apprise_endpoint_url: e.target.value })
                    }
                    placeholder="https://notify.example.com/webhook"
                    autoComplete="off"
                  />
                  <p className="hint">
                    Optional. When set, overrides the default{' '}
                    <span className="font-mono">/notify</span> path construction and POSTs
                    directly to this URL. Useful for custom webhooks or Apprise-compatible
                    proxies. Leave empty to use the Apprise API URL above.
                  </p>
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
                             {formatDiskSize(disk.usedMB)} ({Math.round(disk.usageRatio * 100)}%)
                          </span>
                        </div>
                        <div>
                          <span className="text-ink-500">Free</span>
                          <br />
                          <span className="font-mono tabular-nums">{formatDiskSize(disk.freeMB)}</span>
                        </div>
                        <div>
                          <span className="text-ink-500">Total</span>
                          <br />
                          <span className="font-mono tabular-nums">{formatDiskSize(disk.totalMB)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Registered users */}
            <section className="surface p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-1">
                <div>
                  <h2 className="text-base font-semibold text-white">Users</h2>
                  <p className="hint !mt-1">
                    Registered accounts and storage attributed to their archive memberships.
                    Shared public mirrors are split evenly among members.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-ghost !py-1.5 !px-3 text-xs shrink-0"
                  onClick={refreshAdminData}
                >
                  Refresh
                </button>
              </div>

              {!users || users.length === 0 ? (
                <p className="text-sm text-ink-500 mt-4">No users found.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-800">
                        <th className="pb-2 pr-3 font-medium">User</th>
                        <th className="pb-2 pr-3 font-medium">Repos</th>
                        <th className="pb-2 pr-3 font-medium text-right">Storage</th>
                        <th className="pb-2 font-medium text-right">Last login</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-800/80">
                      {users.map((u) => {
                        const primaryLabel = u.username;
                        const showIdLine = u.id && u.id !== primaryLabel;
                        const secondaryBits = [u.name, u.email].filter(
                          (v) => v && v !== primaryLabel
                        );
                        return (
                          <tr key={u.id} className="align-top">
                            <td className="py-3 pr-3">
                              <div className="font-medium text-ink-100">
                                {primaryLabel}
                                {!u.registered && (
                                  <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-600">
                                    data only
                                  </span>
                                )}
                              </div>
                              {secondaryBits.length > 0 && (
                                <div className="text-xs text-ink-500 mt-0.5">
                                  {secondaryBits.join(' · ')}
                                </div>
                              )}
                              {showIdLine && (
                                <div className="text-[10px] font-mono text-ink-600 mt-0.5 break-all">
                                  {u.id}
                                </div>
                              )}
                            </td>
                            <td className="py-3 pr-3 text-ink-300 whitespace-nowrap">
                              <span className="font-mono tabular-nums">{u.repo_count}</span>
                              {u.private_repo_count > 0 && (
                                <span className="text-ink-500 text-xs ml-1">
                                  ({u.private_repo_count} private)
                                </span>
                              )}
                            </td>
                            <td className="py-3 pr-3 text-right font-mono tabular-nums text-ink-200 whitespace-nowrap">
                              {formatBytes(u.storage_bytes)}
                            </td>
                            <td className="py-3 text-right text-xs text-ink-500 whitespace-nowrap">
                              {u.last_login_at ? formatDate(u.last_login_at) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-800 text-xs text-ink-500">
                        <td className="pt-3 pr-3" colSpan={2}>
                          {users.length} user{users.length === 1 ? '' : 's'}
                        </td>
                        <td className="pt-3 pr-3 text-right font-mono tabular-nums text-ink-300">
                          {formatBytes(totalUserStorage)}
                        </td>
                        <td className="pt-3" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* Save bar — shared across tabs */}
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
