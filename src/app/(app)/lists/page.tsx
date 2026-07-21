'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { LIST_COLORS } from '@/lib/db-client';

interface ListRow {
  id: number;
  name: string;
  description: string | null;
  color: string;
  source: 'local' | 'github';
  github_list_id: string | null;
  repo_count: number;
}

export default function ListsPage() {
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(LIST_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ name: '', description: '', color: '' });

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/lists');
      const data = await res.json();
      setLists(data.lists || []);
    } catch {
      setError('Failed to load lists');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createList(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, color }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setName('');
      setDescription('');
      setColor(LIST_COLORS[(lists.length + 1) % LIST_COLORS.length]);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit(id: number) {
    try {
      const res = await fetch(`/api/lists/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setEditing(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function remove(id: number, listName: string) {
    if (!confirm(`Delete list “${listName}”? Repos are kept.`)) return;
    await fetch(`/api/lists/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-amber-400/80 mb-2">
          Organize
        </p>
        <h1 className="page-title">Lists</h1>
        <p className="page-subtitle">
          Tag repositories with local lists. GitHub star lists are created automatically
          when you import stars.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <section className="surface p-5 mb-6">
        <h2 className="text-sm font-semibold text-white mb-3">New list</h2>
        <form onSubmit={createList} className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="list-name">
                Name
              </label>
              <input
                id="list-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Self-hosted tools"
                required
              />
            </div>
            <div>
              <label className="label">Color</label>
              <div className="flex flex-wrap gap-2 pt-1">
                {LIST_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`h-7 w-7 rounded-full border-2 transition-transform ${
                      color === c
                        ? 'border-white scale-110'
                        : 'border-transparent opacity-80 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="list-desc">
              Description
            </label>
            <input
              id="list-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create list'}
          </button>
        </form>
      </section>

      {loading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : lists.length === 0 ? (
        <div className="surface px-6 py-12 text-center text-sm text-ink-500">
          No lists yet. Create one above, or{' '}
          <Link href="/import" className="text-amber-400 hover:underline">
            import GitHub stars
          </Link>{' '}
          to pull star lists.
        </div>
      ) : (
        <ul className="space-y-2">
          {lists.map((list) => (
            <li key={list.id} className="surface p-4">
              {editing === list.id ? (
                <div className="space-y-3">
                  <input
                    className="input"
                    value={editDraft.name}
                    onChange={(e) =>
                      setEditDraft((d) => ({ ...d, name: e.target.value }))
                    }
                  />
                  <input
                    className="input"
                    value={editDraft.description}
                    onChange={(e) =>
                      setEditDraft((d) => ({ ...d, description: e.target.value }))
                    }
                    placeholder="Description"
                  />
                  <div className="flex flex-wrap gap-2">
                    {LIST_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setEditDraft((d) => ({ ...d, color: c }))}
                        className={`h-6 w-6 rounded-full border-2 ${
                          editDraft.color === c ? 'border-white' : 'border-transparent'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => saveEdit(list.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: list.color }}
                      />
                      <Link
                        href={`/?list=${list.id}`}
                        className="font-medium text-white hover:text-amber-300"
                      >
                        {list.name}
                      </Link>
                      <span className="badge-muted font-mono">
                        {list.repo_count}
                      </span>
                      {list.source === 'github' && (
                        <span className="badge-amber">GitHub</span>
                      )}
                    </div>
                    {list.description && (
                      <p className="text-xs text-ink-500 mt-1">{list.description}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      className="btn-ghost !py-1 !px-2 text-xs"
                      onClick={() => {
                        setEditing(list.id);
                        setEditDraft({
                          name: list.name,
                          description: list.description || '',
                          color: list.color,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !py-1 !px-2 text-xs text-red-400"
                      onClick={() => remove(list.id, list.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
