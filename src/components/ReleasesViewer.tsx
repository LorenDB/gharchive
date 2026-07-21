'use client';

import { useState } from 'react';
import { formatBytes, formatDateShort } from '@/lib/format';

interface Asset {
  id: number;
  name: string;
  content_type: string | null;
  size: number | null;
  file_path: string | null;
  download_url: string | null;
}

interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  assets: Asset[];
}

export default function ReleasesViewer({
  repoId,
  releases,
}: {
  repoId: string | number;
  releases: Release[];
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (releases.length === 0) {
    return (
      <div className="rounded-lg border border-gray-800 px-4 py-10 text-center">
        <p className="text-sm text-gray-500">No releases archived yet.</p>
        <p className="text-xs text-gray-600 mt-1">
          Sync this repository to fetch releases and download assets.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {releases.map((rel) => {
        const isOpen = expanded[rel.id] ?? true;
        const localAssets = rel.assets?.filter((a) => a.file_path) ?? [];
        const remoteOnly =
          rel.assets?.filter((a) => !a.file_path && a.download_url) ?? [];

        return (
          <article
            key={rel.id}
            className="rounded-lg border border-gray-800 bg-gray-900/40 overflow-hidden"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-gray-800/80">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-white">
                    {rel.name && rel.name !== rel.tag_name
                      ? rel.name
                      : rel.tag_name}
                  </h3>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono border border-green-900/60 bg-green-950/40 text-green-400">
                    {rel.tag_name}
                  </span>
                </div>
                {rel.published_at && (
                  <p className="text-xs text-gray-500 mt-1">
                    Published {formatDateShort(rel.published_at)}
                  </p>
                )}
              </div>
              <button
                onClick={() =>
                  setExpanded((e) => ({ ...e, [rel.id]: !isOpen }))
                }
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                {isOpen ? 'Collapse' : 'Expand'}
              </button>
            </header>

            {isOpen && (
              <div className="px-4 py-3 space-y-4">
                {rel.body && (
                  <div className="prose-release text-sm text-gray-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                    {rel.body}
                  </div>
                )}

                {rel.assets && rel.assets.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">
                      Assets ({rel.assets.length})
                    </h4>
                    <ul className="divide-y divide-gray-800/80 rounded-md border border-gray-800 overflow-hidden">
                      {rel.assets.map((asset) => {
                        const isLocal = Boolean(asset.file_path);
                        const href = isLocal
                          ? `/api/repos/${repoId}/assets/${asset.id}`
                          : asset.download_url || undefined;

                        return (
                          <li
                            key={asset.id}
                            className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-950/40 hover:bg-gray-900/60"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <PackageIcon />
                              {href ? (
                                <a
                                  href={href}
                                  className="font-mono text-sm text-blue-400 hover:underline truncate"
                                  download={isLocal ? asset.name : undefined}
                                  target={isLocal ? undefined : '_blank'}
                                  rel={
                                    isLocal ? undefined : 'noopener noreferrer'
                                  }
                                >
                                  {asset.name}
                                </a>
                              ) : (
                                <span className="font-mono text-sm text-gray-300 truncate">
                                  {asset.name}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0 text-xs">
                              <span className="text-gray-600 font-mono">
                                {formatBytes(asset.size)}
                              </span>
                              <span
                                className={
                                  isLocal
                                    ? 'text-green-500'
                                    : 'text-yellow-600'
                                }
                                title={
                                  isLocal
                                    ? 'Stored locally'
                                    : 'Not downloaded — link goes upstream'
                                }
                              >
                                {isLocal ? 'local' : 'remote'}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {(localAssets.length > 0 || remoteOnly.length > 0) && (
                      <p className="text-[11px] text-gray-600 mt-2">
                        {localAssets.length} local
                        {remoteOnly.length > 0
                          ? ` · ${remoteOnly.length} remote-only`
                          : ''}
                      </p>
                    )}
                  </div>
                )}

                {(!rel.assets || rel.assets.length === 0) && (
                  <p className="text-xs text-gray-600">No assets for this release.</p>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function PackageIcon() {
  return (
    <svg
      className="w-4 h-4 text-gray-500 shrink-0"
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden
    >
      <path d="m8.878.392 5.25 3.045c.54.314.872.89.872 1.514v6.098a1.75 1.75 0 0 1-.872 1.514l-5.25 3.045a1.75 1.75 0 0 1-1.756 0l-5.25-3.045A1.75 1.75 0 0 1 1 11.049V4.951c0-.624.332-1.201.872-1.514L7.122.392a1.75 1.75 0 0 1 1.756 0ZM7.875 1.69l-4.63 2.685L8 7.133l4.755-2.758-4.63-2.685a.248.248 0 0 0-.25 0ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432Z" />
    </svg>
  );
}
