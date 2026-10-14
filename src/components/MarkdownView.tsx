'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { rewriteReadmeAssetUrl } from '@/lib/readme-urls';

/**
 * Sanitize schema based on GitHub's defaults, plus attributes commonly
 * used in README HTML tables/images (align, width, etc.).
 *
 * NOTE: rehype-raw must run BEFORE rehype-sanitize (see plugins below) —
 * never reorder, or raw HTML would bypass sanitization. `style` is not
 * allowlisted (CSS exfiltration); `a[name/id]` dropped (DOM clobbering).
 */
const readmeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    table: [
      ...(defaultSchema.attributes?.table || []),
      'align',
      'width',
      'border',
      'cellpadding',
      'cellspacing',
    ],
    th: [
      ...(defaultSchema.attributes?.th || []),
      'align',
      'width',
      'colspan',
      'rowspan',
    ],
    td: [
      ...(defaultSchema.attributes?.td || []),
      'align',
      'width',
      'colspan',
      'rowspan',
    ],
    tr: [...(defaultSchema.attributes?.tr || []), 'align'],
    img: [
      ...(defaultSchema.attributes?.img || []),
      'align',
      'width',
      'height',
    ],
    div: [...(defaultSchema.attributes?.div || []), 'align'],
    p: [...(defaultSchema.attributes?.p || []), 'align'],
    h1: [...(defaultSchema.attributes?.h1 || []), 'align'],
    h2: [...(defaultSchema.attributes?.h2 || []), 'align'],
    h3: [...(defaultSchema.attributes?.h3 || []), 'align'],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'details',
    'summary',
  ],
};

export interface MarkdownViewProps {
  content: string;
  className?: string;
  /** When set, relative img srcs are served from the local bare mirror. */
  assetContext?: {
    repoId: string | number;
    ref: string;
    /** Directory of the README within the repo ('' = root). */
    readmeDir: string;
  };
}

/**
 * Dark-theme markdown renderer for README and similar content.
 *
 * Supports GFM (pipe tables, strikethrough, task lists) and sanitized
 * raw HTML — many GitHub READMEs use `<table>` instead of pipe tables.
 * Relative images are rewritten to `/api/repos/:id/raw` when assetContext
 * is provided.
 */
export default function MarkdownView({
  content,
  className = '',
  assetContext,
}: MarkdownViewProps) {
  const components = useMemo(() => {
    return {
      a: ({ href, children, ...props }: any) => {
        const safeHref = isSafeLinkHref(href) ? href : '#';
        return (
          <a
            href={safeHref}
            target={safeHref?.startsWith('#') ? undefined : '_blank'}
            rel={safeHref?.startsWith('#') ? undefined : 'noopener noreferrer'}
            {...props}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, ...props }: any) => {
        const resolved = assetContext
          ? rewriteReadmeAssetUrl(src, assetContext)
          : src;
        // Block non-http(s)/mirror-relative srcs that slipped past sanitize.
        const safeSrc = isSafeImgSrc(resolved) ? resolved : undefined;
        // eslint-disable-next-line @next/next/no-img-element
        return (
          <img
            src={safeSrc}
            alt={alt || ''}
            loading="lazy"
            className="max-w-full rounded-lg border border-ink-800"
            {...props}
          />
        );
      },
      pre: ({ children, ...props }: any) => (
        <pre
          className="overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 p-3 text-[13px] leading-relaxed"
          {...props}
        >
          {children}
        </pre>
      ),
      code: ({ className: codeClass, children, ...props }: any) => {
        const isBlock = Boolean(codeClass);
        if (isBlock) {
          return (
            <code className={`${codeClass || ''} font-mono`} {...props}>
              {children}
            </code>
          );
        }
        return (
          <code
            className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[0.9em] text-amber-200/90"
            {...props}
          >
            {children}
          </code>
        );
      },
      table: ({ children, ...props }: any) => (
        <div className="my-4 overflow-x-auto">
          <table
            className="w-full border-collapse text-sm markdown-table"
            {...props}
          >
            {children}
          </table>
        </div>
      ),
    };
  }, [assetContext]);

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, readmeSchema]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Explicit protocol allowlist — never rely solely on the sanitizer. */
function isSafeLinkHref(href: string | undefined): boolean {
  if (!href) return false;
  const t = href.trim();
  if (!t) return false;
  if (t.startsWith('#')) return true;
  if (t.startsWith('/')) {
    if (t.startsWith('//')) return false;
    return true;
  }
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    // Relative path without leading / (e.g. docs/img.png rewritten upstream)
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t);
  }
}

function isSafeImgSrc(src: string | undefined): boolean {
  if (!src) return false;
  return isSafeLinkHref(src);
}
