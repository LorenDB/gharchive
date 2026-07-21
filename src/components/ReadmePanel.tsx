'use client';

import { useEffect, useState } from 'react';
import MarkdownView from '@/components/MarkdownView';
import { formatBytes } from '@/lib/format';
import { readmeDirFromPath } from '@/lib/readme-urls';

interface ReadmeResponse {
  ref: string;
  found: boolean;
  path: string | null;
  content: string | null;
  size: number;
  /** 'markdown' | 'plain' — plain = mono preformatted (README / README.txt) */
  format?: 'markdown' | 'plain' | null;
  error?: string;
}

export default function ReadmePanel({
  repoId,
  refName,
}: {
  repoId: string;
  /** Optional git ref; when empty the default branch is used. */
  refName?: string;
}) {
  const [data, setData] = useState<ReadmeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (refName) params.set('ref', refName);
        const res = await fetch(
          `/api/repos/${repoId}/readme?${params.toString()}`
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load README');
        if (!cancelled) setData(json);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [repoId, refName]);

  if (loading) {
    return (
      <div className="surface px-5 py-10 text-sm text-ink-500 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        Loading README…
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface px-5 py-6 text-sm text-red-400">{error}</div>
    );
  }

  if (!data?.found || !data.content) {
    return (
      <div className="surface px-5 py-10 text-center text-sm text-ink-500">
        No README found in this repository.
      </div>
    );
  }

  // Prefer server format; fall back to extension check for older responses
  const isMarkdown =
    data.format === 'markdown' ||
    (data.format == null &&
      /\.(md|markdown|mdown)$/i.test(data.path || ''));

  return (
    <div className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-ink-800 bg-ink-950/50">
        <div className="flex items-center gap-2 min-w-0">
          <ReadmeIcon />
          <span className="font-mono text-sm text-ink-100 truncate">
            {data.path}
          </span>
          <span className="text-xs text-ink-600 shrink-0">
            {formatBytes(data.size)}
          </span>
          {!isMarkdown && (
            <span className="badge-muted text-[10px]">plain text</span>
          )}
        </div>
        {data.ref && (
          <span className="badge-muted font-mono text-[10px] shrink-0">
            {data.ref}
          </span>
        )}
      </div>
      <div className="px-5 py-5 sm:px-6 sm:py-6 max-h-[48rem] overflow-y-auto">
        {isMarkdown ? (
          <MarkdownView
            content={data.content}
            assetContext={{
              repoId,
              ref: data.ref || refName || '',
              readmeDir: readmeDirFromPath(data.path),
            }}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-ink-200 m-0">
            {data.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function ReadmeIcon() {
  return (
    <svg
      className="w-4 h-4 text-ink-500 shrink-0"
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden
    >
      <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM3.5 3.75c0-.192.168-.35.375-.35h8.25c.207 0 .375.158.375.35v.5c0 .192-.168.35-.375.35H3.875A.358.358 0 0 1 3.5 4.25Zm0 2.5c0-.192.168-.35.375-.35h8.25c.207 0 .375.158.375.35v.5c0 .192-.168.35-.375.35H3.875A.358.358 0 0 1 3.5 6.75Zm0 2.5c0-.192.168-.35.375-.35H8c.207 0 .375.158.375.35v.5c0 .192-.168.35-.375.35H3.875A.358.358 0 0 1 3.5 9.25Z" />
    </svg>
  );
}
