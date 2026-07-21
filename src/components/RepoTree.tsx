'use client';

import { useState, useEffect } from 'react';
import { formatBytes } from '@/lib/format';

interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  name: string;
  size?: number;
}

interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

interface TreeResponse {
  ref: string;
  path: string;
  entries: TreeEntry[];
  branches: string[];
  tags: string[];
  commit: CommitInfo | null;
  error?: string;
}

interface BlobResponse {
  ref: string;
  path: string;
  name: string;
  content: string;
  size: number;
  binary: boolean;
  encoding: 'utf-8' | 'base64';
  error?: string;
}

type View =
  | { kind: 'tree'; path: string }
  | { kind: 'blob'; path: string };

export default function RepoTree({ repoId }: { repoId: string }) {
  const [ref, setRef] = useState('');
  const [view, setView] = useState<View>({ kind: 'tree', path: '' });
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [blob, setBlob] = useState<BlobResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refOpen, setRefOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        if (view.kind === 'tree') {
          setBlob(null);
          const params = new URLSearchParams();
          if (view.path) params.set('path', view.path);
          if (ref) params.set('ref', ref);
          const res = await fetch(`/api/repos/${repoId}/tree?${params}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to load tree');
          if (cancelled) return;
          setTree(data);
          if (!ref && data.ref) setRef(data.ref);
        } else {
          const params = new URLSearchParams({ path: view.path });
          if (ref) params.set('ref', ref);
          const res = await fetch(`/api/repos/${repoId}/blob?${params}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to load file');
          if (cancelled) return;
          setBlob(data);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          if (view.kind === 'tree') setTree(null);
          else setBlob(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [view, ref, repoId]);

  function navigateTo(path: string, kind: 'tree' | 'blob') {
    setView({ kind, path });
  }

  function goUp() {
    if (view.kind === 'blob') {
      const parent = view.path.includes('/')
        ? view.path.slice(0, view.path.lastIndexOf('/'))
        : '';
      setView({ kind: 'tree', path: parent });
      return;
    }
    if (!view.path) return;
    const parent = view.path.includes('/')
      ? view.path.slice(0, view.path.lastIndexOf('/'))
      : '';
    setView({ kind: 'tree', path: parent });
  }

  function changeRef(newRef: string) {
    setRef(newRef);
    setRefOpen(false);
    setView({ kind: 'tree', path: '' });
  }

  const crumbs = buildBreadcrumbs(view.path);
  const currentPath = view.kind === 'tree' ? view.path : parentDir(view.path);

  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 bg-ink-950/50 border-b border-ink-800">
        <div className="relative">
          <button
            onClick={() => setRefOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-ink-700 bg-ink-900 text-sm font-mono hover:border-ink-600 transition-colors"
          >
            <BranchIcon />
            <span className="max-w-[10rem] truncate text-ink-100">{ref || '…'}</span>
            <ChevronIcon />
          </button>
          {refOpen && tree && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setRefOpen(false)} />
              <div className="absolute left-0 top-full mt-1.5 z-20 w-64 max-h-72 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 shadow-card">
                {tree.branches.length > 0 && (
                  <div>
                    <p className="px-3 py-2 text-[10px] uppercase tracking-wide text-ink-500 sticky top-0 bg-ink-900 border-b border-ink-800/50">
                      Branches
                    </p>
                    {tree.branches.map((b) => (
                      <button
                        key={b}
                        onClick={() => changeRef(b)}
                        className={`block w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-ink-850 ${
                          b === ref ? 'text-amber-300' : 'text-ink-200'
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                )}
                {tree.tags.length > 0 && (
                  <div>
                    <p className="px-3 py-2 text-[10px] uppercase tracking-wide text-ink-500 sticky top-0 bg-ink-900 border-t border-ink-800">
                      Tags
                    </p>
                    {tree.tags.slice(0, 50).map((t) => (
                      <button
                        key={t}
                        onClick={() => changeRef(t)}
                        className={`block w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-ink-850 ${
                          t === ref ? 'text-amber-300' : 'text-ink-200'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <nav className="flex items-center gap-1 text-sm min-w-0 flex-1 overflow-x-auto">
          <button
            onClick={() => navigateTo('', 'tree')}
            className="text-amber-400/90 hover:text-amber-300 font-mono shrink-0"
          >
            root
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="flex items-center gap-1 shrink-0">
              <span className="text-ink-700">/</span>
              {c.isLast && view.kind === 'blob' ? (
                <span className="font-mono text-ink-100">{c.name}</span>
              ) : (
                <button
                  onClick={() => navigateTo(c.path, 'tree')}
                  className="text-amber-400/90 hover:text-amber-300 font-mono"
                >
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      </div>

      {tree?.commit && view.kind === 'tree' && (
        <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-ink-800 bg-ink-950/30">
          <span className="font-medium text-ink-200 truncate max-w-[12rem]">
            {tree.commit.author}
          </span>
          <span className="text-ink-500 truncate flex-1">{tree.commit.subject}</span>
          <span className="font-mono text-ink-600 shrink-0 badge-muted !py-0">
            {tree.commit.sha.slice(0, 7)}
          </span>
        </div>
      )}

      {error && <div className="px-4 py-6 text-sm text-red-400">{error}</div>}

      {loading && !error && (
        <div className="px-4 py-10 text-sm text-ink-500 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
          Loading…
        </div>
      )}

      {!loading && !error && view.kind === 'tree' && tree && (
        <table className="w-full text-sm">
          <tbody>
            {currentPath !== '' && (
              <tr
                className="border-b border-ink-800/60 hover:bg-ink-900/70 cursor-pointer"
                onClick={goUp}
              >
                <td className="px-3 py-2 w-8">
                  <FolderIcon open />
                </td>
                <td className="px-1 py-2 text-amber-400 font-mono" colSpan={2}>
                  ..
                </td>
              </tr>
            )}
            {tree.entries.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-ink-500" colSpan={3}>
                  Empty directory
                </td>
              </tr>
            ) : (
              tree.entries.map((entry) => {
                const entryPath = currentPath
                  ? `${currentPath}/${entry.name}`
                  : entry.name;
                const isDir = entry.type === 'tree';
                return (
                  <tr
                    key={entry.sha + entry.name}
                    className="border-b border-ink-800/40 hover:bg-ink-900/70 cursor-pointer group last:border-0"
                    onClick={() => navigateTo(entryPath, isDir ? 'tree' : 'blob')}
                  >
                    <td className="px-3 py-2 w-8">
                      {isDir ? (
                        <FolderIcon />
                      ) : entry.type === 'commit' ? (
                        <SubmoduleIcon />
                      ) : (
                        <FileIcon />
                      )}
                    </td>
                    <td className="px-1 py-2 font-mono text-ink-200 group-hover:text-amber-300 truncate max-w-0 w-full transition-colors">
                      {entry.name}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-ink-600 font-mono whitespace-nowrap">
                      {isDir ? '—' : formatBytes(entry.size)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {!loading && !error && view.kind === 'blob' && blob && (
        <FileViewer blob={blob} onBack={goUp} />
      )}
    </div>
  );
}

function FileViewer({
  blob,
  onBack,
}: {
  blob: BlobResponse;
  onBack: () => void;
}) {
  const lines =
    !blob.binary && blob.encoding === 'utf-8' ? blob.content.split('\n') : [];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-ink-800 bg-ink-950/40">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <FileIcon />
          <span className="font-mono text-ink-100 truncate">{blob.name}</span>
          <span className="text-xs text-ink-600">
            {formatBytes(blob.size)}
            {lines.length > 0 ? ` · ${lines.length} lines` : ''}
          </span>
        </div>
        <button onClick={onBack} className="btn-ghost !py-1 !px-2 text-xs shrink-0">
          Back
        </button>
      </div>

      {blob.binary || blob.size > 512 * 1024 ? (
        <div className="px-4 py-12 text-center text-sm text-ink-500">
          {blob.size > 512 * 1024
            ? 'File is too large to preview (limit 512 KB).'
            : 'Binary file — preview not available.'}
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[36rem] overflow-y-auto">
          <table className="w-full text-xs font-mono leading-5">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-ink-900/50">
                  <td className="blob-gutter px-3 py-0 text-right text-ink-600 select-none w-12 align-top border-r border-ink-800/60 sticky left-0">
                    {i + 1}
                  </td>
                  <td className="px-3 py-0 text-ink-300 whitespace-pre">
                    {line || ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function buildBreadcrumbs(path: string) {
  if (!path) return [] as { name: string; path: string; isLast: boolean }[];
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join('/'),
    isLast: i === parts.length - 1,
  }));
}

function parentDir(path: string) {
  if (!path.includes('/')) return '';
  return path.slice(0, path.lastIndexOf('/'));
}

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg className="w-4 h-4 text-amber-400/90" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      {open ? (
        <path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.86l-.845 5.47A1.75 1.75 0 0 1 12.025 13H2.75A1.75 1.75 0 0 1 1 11.25V2.75c0-.464.184-.91.513-1.237Z" />
      ) : (
        <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="w-4 h-4 text-ink-500" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
    </svg>
  );
}

function SubmoduleIcon() {
  return (
    <svg className="w-4 h-4 text-ink-500" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.72 6.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-ink-400" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="w-3 h-3 text-ink-500" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z" />
    </svg>
  );
}
