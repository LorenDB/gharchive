import { describe, expect, it } from 'vitest';
import {
  isAbsoluteOrSpecialUrl,
  resolveRepoAssetPath,
  readmeDirFromPath,
  mirrorAssetUrl,
  rewriteReadmeAssetUrl,
  normalizeAbsoluteHttpUrl,
  extractAbsoluteUrls,
} from '@/lib/readme-urls';

describe('isAbsoluteOrSpecialUrl', () => {
  it('returns true for empty/whitespace', () => {
    expect(isAbsoluteOrSpecialUrl('')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('  ')).toBe(true);
  });

  it('returns true for http/https URLs', () => {
    expect(isAbsoluteOrSpecialUrl('https://example.com/img.png')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('http://example.com/img.png')).toBe(true);
  });

  it('returns true for data/blob/mailto URLs', () => {
    expect(isAbsoluteOrSpecialUrl('data:image/png;base64,abc')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('blob:http://example.com')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('mailto:test@example.com')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('cid:attachment')).toBe(true);
    expect(isAbsoluteOrSpecialUrl('javascript:void(0)')).toBe(true);
  });

  it('returns true for protocol-relative URLs', () => {
    expect(isAbsoluteOrSpecialUrl('//cdn.example.com/lib.js')).toBe(true);
  });

  it('returns true for anchor-only hash refs', () => {
    expect(isAbsoluteOrSpecialUrl('#section')).toBe(true);
  });

  it('returns false for relative paths', () => {
    expect(isAbsoluteOrSpecialUrl('img/photo.png')).toBe(false);
    expect(isAbsoluteOrSpecialUrl('./doc/readme.md')).toBe(false);
    expect(isAbsoluteOrSpecialUrl('../parent/file.txt')).toBe(false);
    expect(isAbsoluteOrSpecialUrl('screenshot.png')).toBe(false);
  });

  it('returns false for paths starting with /', () => {
    expect(isAbsoluteOrSpecialUrl('/docs/api.md')).toBe(false);
  });
});

describe('resolveRepoAssetPath', () => {
  it('returns null for absolute/URL hrefs', () => {
    expect(resolveRepoAssetPath('', 'https://example.com/img.png')).toBeNull();
    expect(resolveRepoAssetPath('', '#foo')).toBeNull();
  });

  it('resolves relative path from root to root', () => {
    expect(resolveRepoAssetPath('', 'docs/api.md')).toBe('docs/api.md');
    expect(resolveRepoAssetPath('', './docs/api.md')).toBe('docs/api.md');
  });

  it('resolves relative path from subdirectory', () => {
    expect(resolveRepoAssetPath('docs', 'api.md')).toBe('docs/api.md');
    expect(resolveRepoAssetPath('a/b/c', 'd/e.txt')).toBe('a/b/c/d/e.txt');
  });

  it('handles .. traversal within bounds', () => {
    expect(resolveRepoAssetPath('a/b/c', '../../x.txt')).toBe('a/x.txt');
  });

  it('returns null for .. that escapes root', () => {
    expect(resolveRepoAssetPath('a', '../../secret')).toBeNull();
    expect(resolveRepoAssetPath('', '../outside')).toBeNull();
  });

  it('resolves absolute-within-repo paths', () => {
    expect(resolveRepoAssetPath('sub/dir', '/assets/logo.png')).toBe('assets/logo.png');
  });

  it('returns null for / starting path with .. that escapes root', () => {
    expect(resolveRepoAssetPath('', '/../outside')).toBeNull();
  });

  it('strips query string and hash', () => {
    expect(resolveRepoAssetPath('', 'img/photo.png?v=2')).toBe('img/photo.png');
    expect(resolveRepoAssetPath('', 'img/photo.png#fragment')).toBe('img/photo.png');
  });

  it('handles empty segments and dots', () => {
    expect(resolveRepoAssetPath('a//b', './c/./d.txt')).toBe('a/b/c/d.txt');
  });

  it('returns null for empty path after stripping', () => {
    expect(resolveRepoAssetPath('', '#foo')).toBeNull();
    expect(resolveRepoAssetPath('', '?bar')).toBeNull();
  });

  it('returns null for hash-only input', () => {
    expect(resolveRepoAssetPath('docs', '#section')).toBeNull();
  });

  it('decodes percent-encoded paths', () => {
    expect(resolveRepoAssetPath('', 'hello%20world.txt')).toBe('hello world.txt');
  });
});

describe('readmeDirFromPath', () => {
  it('returns empty string for root paths', () => {
    expect(readmeDirFromPath(null)).toBe('');
    expect(readmeDirFromPath(undefined)).toBe('');
    expect(readmeDirFromPath('')).toBe('');
    expect(readmeDirFromPath('README.md')).toBe('');
  });

  it('returns directory for nested paths', () => {
    expect(readmeDirFromPath('docs/README.md')).toBe('docs');
    expect(readmeDirFromPath('a/b/c/README.md')).toBe('a/b/c');
  });
});

describe('mirrorAssetUrl', () => {
  it('builds URL with path and ref', () => {
    const url = mirrorAssetUrl(42, 'main', 'docs/api.md');
    expect(url).toContain('/api/repos/42/raw');
    expect(url).toContain('path=docs%2Fapi.md');
    expect(url).toContain('ref=main');
  });

  it('omits ref param when ref is empty/falsy', () => {
    const url = mirrorAssetUrl(1, '', 'README.md');
    expect(url).toContain('path=README.md');
    expect(url).not.toContain('ref=');
  });

  it('includes ref param when ref is provided', () => {
    const url = mirrorAssetUrl(1, 'main', 'README.md');
    expect(url).toContain('ref=main');
  });
});

describe('rewriteReadmeAssetUrl', () => {
  const opts = { repoId: 1, ref: 'main', readmeDir: '' };

  it('returns undefined for null/undefined src', () => {
    expect(rewriteReadmeAssetUrl(null, opts)).toBeUndefined();
    expect(rewriteReadmeAssetUrl(undefined, opts)).toBeUndefined();
  });

  it('returns empty string for empty src', () => {
    expect(rewriteReadmeAssetUrl('', opts)).toBe('');
  });

  it('returns absolute URLs unchanged', () => {
    expect(rewriteReadmeAssetUrl('https://example.com/logo.png', opts)).toBe(
      'https://example.com/logo.png'
    );
  });

  it('rewrites relative paths to mirror URLs', () => {
    const result = rewriteReadmeAssetUrl('docs/api.md', opts);
    expect(result).toContain('/api/repos/1/raw');
    expect(result).toContain('path=docs%2Fapi.md');
  });

  it('returns unresolvable relative paths unchanged', () => {
    expect(rewriteReadmeAssetUrl('../../secret', opts)).toBe('../../secret');
  });
});

describe('normalizeAbsoluteHttpUrl', () => {
  it('accepts http/https URLs', () => {
    expect(normalizeAbsoluteHttpUrl('https://example.com/path')).toBe(
      'https://example.com/path'
    );
    expect(normalizeAbsoluteHttpUrl('http://example.com/')).toBe(
      'http://example.com/'
    );
  });

  it('strips hash and trailing punctuation', () => {
    expect(normalizeAbsoluteHttpUrl('https://example.com/a#section')).toBe(
      'https://example.com/a'
    );
    expect(normalizeAbsoluteHttpUrl('https://example.com/a.')).toBe(
      'https://example.com/a'
    );
    expect(normalizeAbsoluteHttpUrl('https://example.com/a,')).toBe(
      'https://example.com/a'
    );
  });

  it('rejects non-http schemes and relative paths', () => {
    expect(normalizeAbsoluteHttpUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeAbsoluteHttpUrl('docs/readme.md')).toBeNull();
    expect(normalizeAbsoluteHttpUrl('/docs/api')).toBeNull();
    expect(normalizeAbsoluteHttpUrl('')).toBeNull();
  });

  it('rejects localhost and credentials-in-url', () => {
    expect(normalizeAbsoluteHttpUrl('http://localhost/foo')).toBeNull();
    expect(normalizeAbsoluteHttpUrl('https://127.0.0.1/x')).toBeNull();
    expect(
      normalizeAbsoluteHttpUrl('https://user:pass@example.com/secret')
    ).toBeNull();
  });

  it('upgrades protocol-relative URLs', () => {
    expect(normalizeAbsoluteHttpUrl('//cdn.example.com/x.js')).toBe(
      'https://cdn.example.com/x.js'
    );
  });
});

describe('extractAbsoluteUrls', () => {
  it('extracts markdown links and images', () => {
    const md = `
# Title
See [docs](https://example.com/docs) and [local](./local.md).
![logo](https://cdn.example.com/logo.png)
[angle](<https://angled.example.com/a>)
`;
    const urls = extractAbsoluteUrls(md);
    expect(urls).toContain('https://example.com/docs');
    expect(urls).toContain('https://cdn.example.com/logo.png');
    expect(urls).toContain('https://angled.example.com/a');
    expect(urls.some((u) => u.includes('local.md'))).toBe(false);
  });

  it('extracts HTML href/src and bare URLs', () => {
    const html = `
<a href="https://a.example.com">A</a>
<img src='https://b.example.com/i.png' />
Visit https://c.example.com/page for more.
`;
    const urls = extractAbsoluteUrls(html);
    expect(urls).toContain('https://a.example.com/');
    expect(urls).toContain('https://b.example.com/i.png');
    expect(urls).toContain('https://c.example.com/page');
  });

  it('dedupes and ignores empty content', () => {
    expect(extractAbsoluteUrls('')).toEqual([]);
    const urls = extractAbsoluteUrls(
      '[a](https://example.com) https://example.com'
    );
    expect(urls).toEqual(['https://example.com/']);
  });

  it('skips data/mailto and relative', () => {
    const md = `[x](mailto:a@b.com) ![y](data:image/png;base64,xx) [z](./rel.png)`;
    expect(extractAbsoluteUrls(md)).toEqual([]);
  });
});

