'use client';

import { useState, useEffect } from 'react';

export default function AddRepoForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clone_url: url }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add repo');
      }
      setUrl('');
      setOpen(false);
      onAdded();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary shrink-0">
        <PlusIcon />
        Add repository
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-ink-975/70 backdrop-blur-sm"
            onClick={() => !loading && setOpen(false)}
          />
          <div className="relative w-full max-w-md surface-solid p-6 shadow-glow animate-in">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-lg font-semibold text-white">Add repository</h2>
              <button
                type="button"
                className="btn-ghost !p-1.5 -mr-1 -mt-1"
                onClick={() => !loading && setOpen(false)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
            <p className="text-sm text-ink-400 mb-5">
              Paste any git clone URL (GitHub, GitLab, Codeberg, or other hosts).
              We&apos;ll mirror the repo and pull releases when the host supports
              them.
            </p>
            <form onSubmit={handleSubmit}>
              <label className="label" htmlFor="clone-url">
                Clone URL
              </label>
              <input
                id="clone-url"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://codeberg.org/owner/repo.git"
                className="input font-mono text-[13px]"
                autoFocus
                disabled={loading}
              />
              {error && (
                <p className="mt-2 text-sm text-red-400 flex items-start gap-1.5">
                  <span className="mt-0.5">⚠</span>
                  {error}
                </p>
              )}
              <div className="mt-6 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={loading}
                  className="btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !url.trim()}
                  className="btn-primary min-w-[7.5rem]"
                >
                  {loading ? (
                    <>
                      <Spinner />
                      Cloning…
                    </>
                  ) : (
                    'Add & sync'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
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
