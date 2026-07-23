import { describe, expect, it, vi } from 'vitest';
import {
  hasWaybackCredentials,
  waybackCredentialsFromSettings,
  saveUrlToWayback,
  saveUrlsToWayback,
  WAYBACK_MAX_URLS_PER_SYNC,
} from '@/lib/wayback';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/db';

function settings(partial: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...partial };
}

describe('wayback credentials helpers', () => {
  it('detects missing keys', () => {
    expect(hasWaybackCredentials(settings())).toBe(false);
    expect(
      hasWaybackCredentials(
        settings({ wayback_access_key: 'ak', wayback_secret_key: '' })
      )
    ).toBe(false);
    expect(
      waybackCredentialsFromSettings(
        settings({ wayback_access_key: 'ak', wayback_secret_key: 'sk' })
      )
    ).toEqual({ accessKey: 'ak', secretKey: 'sk' });
  });
});

describe('saveUrlToWayback', () => {
  const creds = { accessKey: 'AK', secretKey: 'SK' };

  it('POSTs with LOW auth and form body', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ job_id: 'job-1', url: 'https://example.com/' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const r = await saveUrlToWayback('https://example.com/', creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({
      url: 'https://example.com/',
      ok: true,
      jobId: 'job-1',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe('https://web.archive.org/save');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('LOW AK:SK');
    expect(headers.Accept).toBe('application/json');
    const body = String(init.body);
    expect(body).toContain('url=https%3A%2F%2Fexample.com%2F');
    expect(body).toContain('skip_first_archive=1');
    expect(body).toContain('delay_wb_availability=1');
    expect(body).toContain('if_not_archived_within=30d');
  });

  it('treats recent capture response as ok', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          timestamp: '20240101120000',
          original_url: 'https://example.com/',
        }),
        { status: 200 }
      );
    });
    const r = await saveUrlToWayback('https://example.com/', creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.recent).toBe(true);
  });

  it('returns error on HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'user-session-limit' }), {
        status: 429,
      });
    });
    const r = await saveUrlToWayback('https://example.com/', creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('user-session-limit');
  });

  it('returns error on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await saveUrlToWayback('https://example.com/', creds, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network down');
  });
});

describe('saveUrlsToWayback', () => {
  const creds = { accessKey: 'AK', secretKey: 'SK' };

  it('caps batch size and counts submitted/failed', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 2) {
        return new Response(JSON.stringify({ message: 'fail' }), { status: 500 });
      }
      return new Response(JSON.stringify({ job_id: `j-${n}` }), { status: 200 });
    });

    const urls = [
      'https://a.example.com/',
      'https://b.example.com/',
      'https://c.example.com/',
    ];
    const result = await saveUrlsToWayback(urls, creds, {
      maxUrls: 2,
      delayMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.found).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.submitted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it('dedupes URLs before submitting', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ job_id: 'j1' }), { status: 200 });
    });
    const result = await saveUrlsToWayback(
      ['https://example.com/', 'https://example.com/'],
      creds,
      { delayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(result.found).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('default max is WAYBACK_MAX_URLS_PER_SYNC', () => {
    expect(WAYBACK_MAX_URLS_PER_SYNC).toBe(50);
  });
});
