'use client';

import { useCallback, useEffect, useState } from 'react';

interface PendingHost {
  hostname: string;
  sample_url: string;
  repo_label: string;
  first_seen_at: string;
}

/**
 * Polls for release-asset download hosts awaiting user approval and shows
 * a modal (one host at a time). Used when Forgejo (or other) remotes serve
 * assets from a domain other than the repo host.
 */
export default function AssetHostApprovalModal() {
  const [pending, setPending] = useState<PendingHost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/asset-hosts');
      if (!res.ok) return;
      const data = await res.json();
      setPending(Array.isArray(data.pending) ? data.pending : []);
    } catch {
      // ignore poll errors
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 8_000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // Clear transient success banner
  useEffect(() => {
    if (!lastResult) return;
    const t = window.setTimeout(() => setLastResult(null), 5_000);
    return () => window.clearTimeout(t);
  }, [lastResult]);

  const current = pending[0] ?? null;

  async function decide(action: 'approve' | 'reject') {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/asset-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, hostname: current.hostname }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      setPending(Array.isArray(data.pending) ? data.pending : []);
      if (action === 'approve') {
        const n = typeof data.downloaded === 'number' ? data.downloaded : 0;
        setLastResult(
          n > 0
            ? `Approved ${current.hostname} — downloaded ${n} asset(s).`
            : `Approved ${current.hostname}. Assets will download on the next sync.`
        );
      } else {
        setLastResult(`Rejected downloads from ${current.hostname}.`);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {lastResult && !current && (
        <div className="fixed bottom-4 right-4 z-40 max-w-sm surface-solid px-4 py-3 text-sm text-ink-200 shadow-glow animate-in">
          {lastResult}
        </div>
      )}

      {current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink-975/70 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-host-title"
            className="relative w-full max-w-md surface-solid p-6 shadow-glow animate-in"
          >
            <div className="flex items-start gap-3 mb-1">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
                <ShieldIcon />
              </div>
              <div className="min-w-0">
                <h2
                  id="asset-host-title"
                  className="text-lg font-semibold text-white"
                >
                  Allow download domain?
                </h2>
                <p className="text-sm text-ink-400 mt-1">
                  Release assets for{' '}
                  <span className="text-ink-200 font-medium">
                    {current.repo_label}
                  </span>{' '}
                  are hosted on a different domain than the repository.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-ink-800 bg-ink-950/50 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wide text-ink-500 mb-1">
                Domain
              </p>
              <p className="font-mono text-sm text-mint-400 break-all">
                {current.hostname}
              </p>
              {current.sample_url && (
                <>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500 mt-3 mb-1">
                    Sample URL
                  </p>
                  <p className="font-mono text-[11px] text-ink-400 break-all leading-relaxed max-h-16 overflow-y-auto">
                    {current.sample_url}
                  </p>
                </>
              )}
            </div>

            <p className="mt-4 text-xs text-ink-500 leading-relaxed">
              Approving lets GHArchive download release assets from this host
              (HTTPS only). Rejecting skips those assets permanently until you
              change it in Settings.
              {pending.length > 1 && (
                <span className="block mt-1 text-ink-400">
                  {pending.length - 1} more domain
                  {pending.length - 1 === 1 ? '' : 's'} waiting after this.
                </span>
              )}
            </p>

            {error && (
              <p className="mt-3 text-sm text-red-400 flex items-start gap-1.5">
                <span className="mt-0.5">⚠</span>
                {error}
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide('reject')}
                className="btn-ghost min-w-[6.5rem]"
              >
                {busy ? '…' : 'Reject'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide('approve')}
                className="btn-primary min-w-[7.5rem]"
              >
                {busy ? (
                  <>
                    <Spinner />
                    Working…
                  </>
                ) : (
                  'Approve domain'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ShieldIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3l7 3v5c0 4.5-2.8 8.4-7 10-4.2-1.6-7-5.5-7-10V6l7-3z"
      />
    </svg>
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
