import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { checkCsrf } from '@/lib/api-auth';

function req(
  method: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest('http://localhost:3000/api/repos', {
    method,
    headers,
  });
}

describe('checkCsrf', () => {
  const prevApp = process.env.APP_URL;

  beforeEach(() => {
    process.env.APP_URL = 'https://archive.example.com';
  });

  afterEach(() => {
    if (prevApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevApp;
  });

  it('allows safe methods without origin', () => {
    expect(checkCsrf(req('GET'))).toBeNull();
  });

  it('allows matching Origin', () => {
    expect(
      checkCsrf(
        req('POST', { origin: 'https://archive.example.com' })
      )
    ).toBeNull();
  });

  it('allows matching Referer', () => {
    expect(
      checkCsrf(
        req('POST', {
          referer: 'https://archive.example.com/settings',
        })
      )
    ).toBeNull();
  });

  it('rejects missing Origin and Referer when APP_URL is set', async () => {
    const res = checkCsrf(req('POST'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('rejects attacker Origin even if Host/X-Forwarded-Host match attacker', async () => {
    const res = checkCsrf(
      req('POST', {
        origin: 'https://evil.com',
        host: 'evil.com',
        'x-forwarded-host': 'evil.com',
      })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('rejects wrong Origin', async () => {
    const res = checkCsrf(
      req('POST', { origin: 'https://evil.com' })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
