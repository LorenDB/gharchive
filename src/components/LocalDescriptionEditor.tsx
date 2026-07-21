'use client';

import { useEffect, useState } from 'react';

/**
 * User-authored archive notes — separate from the remote description.
 * Autosaves on blur / explicit Save; Escape cancels edit mode.
 */
export default function LocalDescriptionEditor({
  repoId,
  value,
  onSaved,
}: {
  repoId: string;
  value: string | null | undefined;
  onSaved: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_description: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      const next = data.repo?.local_description ?? (draft.trim() || null);
      onSaved(next);
      setEditing(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(value || '');
    setError('');
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="surface p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <h3 className="text-sm font-medium text-ink-100">Archive notes</h3>
            <p className="hint !mt-0.5">
              Your notes on why this repo is archived (local only).
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !py-1 !px-2 text-xs shrink-0"
            onClick={() => setEditing(true)}
          >
            {value ? 'Edit' : 'Add notes'}
          </button>
        </div>
        {value ? (
          <p className="text-sm text-ink-200 whitespace-pre-wrap leading-relaxed">
            {value}
          </p>
        ) : (
          <p className="text-sm text-ink-600 italic">
            No archive notes yet. Document why you&apos;re keeping this mirror.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="surface p-4">
      <div className="mb-2">
        <h3 className="text-sm font-medium text-ink-100">Archive notes</h3>
        <p className="hint !mt-0.5">
          Separate from the remote description. Max 10,000 characters.
        </p>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        maxLength={10000}
        placeholder="e.g. Critical dependency used by project X; upstream has been unmaintained since 2022…"
        className="input font-sans text-sm min-h-[6rem] resize-y"
        autoFocus
        disabled={saving}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      />
      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-600 font-mono">
          {draft.length}/10000
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-ghost !py-1.5"
            onClick={cancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary !py-1.5"
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
