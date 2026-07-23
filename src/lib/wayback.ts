/**
 * Internet Archive Save Page Now 2 (SPN2) client.
 *
 * Docs (unofficial mirror of IA Google Doc):
 * https://gist.github.com/regstuff/82e690db2f1d91ba59f6681c1abad6cf
 *
 * Auth: S3 API keys from https://archive.org/account/s3.php
 * Header: Authorization: LOW {accessKey}:{secretKey}
 * Endpoint: POST https://web.archive.org/save
 */

import { extractAbsoluteUrls } from '@/lib/readme-urls';
import { getDefaultBranch, getReadmeBlob } from '@/lib/git';
import { README_CANDIDATES } from '@/lib/remote-meta';
import type { Settings } from '@/lib/db';

const SPN2_SAVE_URL = 'https://web.archive.org/save';

/** Max URLs submitted per repo per sync (avoid rate limits / long syncs). */
export const WAYBACK_MAX_URLS_PER_SYNC = 50;

/**
 * Only re-submit if Wayback has no capture newer than this.
 * SPN2 timedelta format (e.g. "30d", "7d", "120").
 */
export const WAYBACK_IF_NOT_ARCHIVED_WITHIN = '30d';

/** Small pause between captures to stay polite to archive.org. */
const INTER_REQUEST_DELAY_MS = 250;

export type WaybackCredentials = {
  accessKey: string;
  secretKey: string;
};

export type WaybackSaveResult = {
  url: string;
  ok: boolean;
  /** SPN2 job id when a new capture was queued */
  jobId?: string;
  /** True when SPN2 returned an existing recent capture (if_not_archived_within) */
  recent?: boolean;
  error?: string;
};

export type WaybackBatchResult = {
  found: number;
  submitted: number;
  skipped: number;
  failed: number;
  results: WaybackSaveResult[];
};

export function hasWaybackCredentials(settings: Settings): boolean {
  return Boolean(
    settings.wayback_access_key?.trim() && settings.wayback_secret_key?.trim()
  );
}

export function waybackCredentialsFromSettings(
  settings: Settings
): WaybackCredentials | null {
  const accessKey = settings.wayback_access_key?.trim() || '';
  const secretKey = settings.wayback_secret_key?.trim() || '';
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit one URL to SPN2. Fire-and-forget style: does not poll job status.
 * Uses delay_wb_availability + skip_first_archive + if_not_archived_within
 * to reduce load and avoid re-capturing recent snapshots.
 */
export async function saveUrlToWayback(
  url: string,
  credentials: WaybackCredentials,
  options: {
    ifNotArchivedWithin?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<WaybackSaveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ifNot =
    options.ifNotArchivedWithin ?? WAYBACK_IF_NOT_ARCHIVED_WITHIN;

  const body = new URLSearchParams();
  body.set('url', url);
  body.set('skip_first_archive', '1');
  body.set('delay_wb_availability', '1');
  if (ifNot) body.set('if_not_archived_within', ifNot);

  try {
    const res = await fetchImpl(SPN2_SAVE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Authorization: `LOW ${credentials.accessKey}:${credentials.secretKey}`,
      },
      body: body.toString(),
      // Do not hang the whole sync on a stuck IA request
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // non-JSON body
    }

    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.status_ext === 'string' && data.status_ext) ||
        text.slice(0, 200) ||
        `HTTP ${res.status}`;
      return { url, ok: false, error: msg };
    }

    // New job queued
    if (typeof data.job_id === 'string' && data.job_id) {
      return { url, ok: true, jobId: data.job_id };
    }

    // Recent capture returned (if_not_archived_within hit)
    if (
      typeof data.timestamp === 'string' ||
      data.status === 'success' ||
      typeof data.original_url === 'string'
    ) {
      return { url, ok: true, recent: true };
    }

    // Unknown success shape — treat as submitted if 2xx
    return { url, ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, ok: false, error: msg };
  }
}

/**
 * Submit a list of URLs sequentially (with small delays).
 * Caps at WAYBACK_MAX_URLS_PER_SYNC.
 */
export async function saveUrlsToWayback(
  urls: string[],
  credentials: WaybackCredentials,
  options: {
    ifNotArchivedWithin?: string;
    maxUrls?: number;
    fetchImpl?: typeof fetch;
    delayMs?: number;
  } = {}
): Promise<WaybackBatchResult> {
  const max = options.maxUrls ?? WAYBACK_MAX_URLS_PER_SYNC;
  const delayMs = options.delayMs ?? INTER_REQUEST_DELAY_MS;
  const unique = [...new Set(urls.filter(Boolean))];
  const found = unique.length;
  const batch = unique.slice(0, max);
  const skipped = found - batch.length;

  const results: WaybackSaveResult[] = [];
  let submitted = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const r = await saveUrlToWayback(batch[i], credentials, {
      ifNotArchivedWithin: options.ifNotArchivedWithin,
      fetchImpl: options.fetchImpl,
    });
    results.push(r);
    if (r.ok) submitted++;
    else failed++;
  }

  return { found, submitted, skipped, failed, results };
}

/**
 * Read README from a bare mirror, extract absolute URLs, submit to Wayback.
 * Best-effort: never throws; returns a short log message.
 */
export async function archiveReadmeUrlsFromMirror(
  mirrorPath: string,
  credentials: WaybackCredentials,
  options: {
    ifNotArchivedWithin?: string;
    maxUrls?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<{ message: string; result: WaybackBatchResult | null }> {
  try {
    let ref = 'HEAD';
    try {
      ref = await getDefaultBranch(mirrorPath);
    } catch {
      // fall back to HEAD
    }

    const readme = await getReadmeBlob(mirrorPath, ref, README_CANDIDATES);
    if (!readme?.content) {
      return {
        message: 'wayback: no README',
        result: null,
      };
    }

    const urls = extractAbsoluteUrls(readme.content);
    if (urls.length === 0) {
      return {
        message: 'wayback: no absolute URLs in README',
        result: { found: 0, submitted: 0, skipped: 0, failed: 0, results: [] },
      };
    }

    const result = await saveUrlsToWayback(urls, credentials, options);
    const parts = [
      `wayback: ${result.found} URL(s) in README`,
      `${result.submitted} submitted`,
    ];
    if (result.skipped > 0) parts.push(`${result.skipped} capped`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    return { message: parts.join(', '), result };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      message: `wayback: failed - ${msg.slice(0, 200)}`,
      result: null,
    };
  }
}
