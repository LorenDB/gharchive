'use client';

import { useEffect, useState } from 'react';

type Mode = 'all' | 'none' | 'last_n';
type OverrideMode = 'inherit' | Mode;

/**
 * Per-repo override for how release assets are cached.
 * null mode = inherit from user settings.
 */
export default function ReleaseAssetPolicyEditor({
  repoId,
  mode,
  keepLast,
  globalMode,
  globalKeepLast,
  onSaved,
}: {
  repoId: string;
  mode: Mode | null | undefined;
  keepLast: number | null | undefined;
  globalMode: Mode;
  globalKeepLast: number;
  onSaved: (next: {
    release_asset_mode: Mode | null;
    release_asset_keep_last: number | null;
  }) => void;
}) {
  const [overrideMode, setOverrideMode] = useState<OverrideMode>(
    mode ?? 'inherit'
  );
  const [keep, setKeep] = useState<number>(
    keepLast != null && keepLast >= 1 ? keepLast : globalKeepLast
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setOverrideMode(mode ?? 'inherit');
    setKeep(keepLast != null && keepLast >= 1 ? keepLast : globalKeepLast);
  }, [mode, keepLast, globalKeepLast]);

  const dirty =
    overrideMode !== (mode ?? 'inherit') ||
    (overrideMode === 'last_n' &&
      keep !== (keepLast != null && keepLast >= 1 ? keepLast : globalKeepLast));

  async function save() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const body: Record<string, unknown> = {
        release_asset_mode: overrideMode === 'inherit' ? null : overrideMode,
        // Clear keep override unless this repo explicitly uses last_n
        release_asset_keep_last: overrideMode === 'last_n' ? keep : null,
      };

      const res = await fetch(`/api/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');

      const nextMode =
        (data.repo?.release_asset_mode as Mode | null | undefined) ?? null;
      const nextKeep =
        (data.repo?.release_asset_keep_last as number | null | undefined) ??
        null;
      onSaved({
        release_asset_mode: nextMode,
        release_asset_keep_last: nextKeep,
      });
      setMessage('Saved');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const effective: Mode =
    overrideMode === 'inherit' ? globalMode : overrideMode;
  const effectiveKeep =
    overrideMode === 'last_n'
      ? keep
      : overrideMode === 'inherit' && globalMode === 'last_n'
        ? globalKeepLast
        : keep;

  function globalLabel(): string {
    if (globalMode === 'none') return 'None (metadata only)';
    if (globalMode === 'last_n') return `Last ${globalKeepLast}`;
    return 'All releases';
  }

  return (
    <div className="surface p-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium text-ink-100">Release asset archive</h3>
        <p className="hint !mt-0.5">
          Override the global setting for this repository only. Effective:{' '}
          <span className="text-ink-300">
            {effective === 'none'
              ? 'none'
              : effective === 'last_n'
                ? `last ${effectiveKeep}`
                : 'all'}
          </span>
          .
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 mb-3">
        {(
          [
            {
              id: 'inherit' as const,
              label: 'Use default',
              desc: globalLabel(),
            },
            {
              id: 'all' as const,
              label: 'All releases',
              desc: 'Cache every release',
            },
            {
              id: 'last_n' as const,
              label: 'Last N',
              desc: 'Newest N only',
            },
            {
              id: 'none' as const,
              label: 'None',
              desc: 'Metadata only',
            },
          ] as const
        ).map((opt) => {
          const active = overrideMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setOverrideMode(opt.id)}
              className={`rounded-xl border px-3 py-2.5 text-left transition ${
                active
                  ? 'border-amber-400/50 bg-amber-400/10'
                  : 'border-ink-800 bg-ink-950/40 hover:border-ink-700'
              }`}
            >
              <span
                className={`block text-sm font-medium ${
                  active ? 'text-amber-200' : 'text-ink-200'
                }`}
              >
                {opt.label}
              </span>
              <span className="block text-[11px] text-ink-500 mt-0.5">
                {opt.desc}
              </span>
            </button>
          );
        })}
      </div>

      {overrideMode === 'last_n' && (
        <div className="mb-3">
          <label className="label" htmlFor={`keep-last-${repoId}`}>
            Keep last N releases
          </label>
          <input
            id={`keep-last-${repoId}`}
            type="number"
            min={1}
            max={10000}
            className="input max-w-[10rem]"
            value={keep}
            onChange={(e) =>
              setKeep(Math.max(1, parseInt(e.target.value || '1', 10)))
            }
            disabled={saving}
          />
          <p className="hint">
            When a new release is discovered, assets for the oldest beyond N are
            dropped.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {message && !error && (
        <p className="text-sm text-mint-400 mb-2">{message}</p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary !py-1.5"
          onClick={save}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : dirty ? 'Save policy' : 'Saved'}
        </button>
      </div>
    </div>
  );
}
