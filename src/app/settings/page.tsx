'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatDate } from '@/lib/format';

interface Settings {
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  download_release_assets: boolean;
  max_asset_size_mb: number;
  concurrent_syncs: number;
}

interface SchedulerStatus {
  started: boolean;
  running: boolean;
  last_run_at: string | null;
  last_run_summary: string | null;
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
}

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

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data.settings);
      setDraft(data.settings);
      setIntervals(data.interval_options || [1, 6, 12, 24, 48, 168]);
      setScheduler(data.scheduler);
    } catch {
      setMessage({ type: 'err', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    draft &&
    settings &&
    JSON.stringify(draft) !== JSON.stringify(settings);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSettings(data.settings);
      setDraft(data.settings);
      setScheduler(data.scheduler);
      setMessage({ type: 'ok', text: 'Settings saved' });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function runAllNow() {
    setRunningAll(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setScheduler(data.scheduler);
      setMessage({
        type: 'ok',
        text: data.message || `Synced ${data.synced} repositories`,
      });
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message });
    } finally {
      setRunningAll(false);
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
