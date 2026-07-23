import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  normalizeRepoRelativePath,
  contentTypeForPath,
  shouldForceAttachment,
  isRemoteMissingError,
  getMirrorPath,
  assertSafeGitArg,
} from '@/lib/git';

describe('normalizeRepoRelativePath', () => {
  it('returns null for empty/whitespace input', () => {
    expect(normalizeRepoRelativePath('', '')).toBeNull();
    expect(normalizeRepoRelativePath('', '  ')).toBeNull();
  });

  it('returns null for absolute URLs', () => {
    expect(normalizeRepoRelativePath('', 'https://example.com/file.txt')).toBeNull();
    expect(normalizeRepoRelativePath('', 'data:image/png,abc')).toBeNull();
    expect(normalizeRepoRelativePath('', '//cdn.example.com/lib.js')).toBeNull();
  });

  it('resolves relative path from root', () => {
    expect(normalizeRepoRelativePath('', 'src/main.ts')).toBe('src/main.ts');
  });

  it('resolves relative path from subdirectory', () => {
    expect(normalizeRepoRelativePath('src', 'main.ts')).toBe('src/main.ts');
    expect(normalizeRepoRelativePath('a/b', 'c/d.txt')).toBe('a/b/c/d.txt');
  });

  it('handles .. within bounds', () => {
    expect(normalizeRepoRelativePath('a/b/c', '../../x.txt')).toBe('a/x.txt');
  });

  it('returns null for .. that escapes root', () => {
    expect(normalizeRepoRelativePath('a', '../../secret')).toBeNull();
    expect(normalizeRepoRelativePath('', '../outside')).toBeNull();
  });

  it('handles absolute-within-repo paths', () => {
    expect(normalizeRepoRelativePath('any/where', '/root-file.txt')).toBe('root-file.txt');
  });

  it('strips query and hash', () => {
    expect(normalizeRepoRelativePath('', 'file.txt?v=2')).toBe('file.txt');
    expect(normalizeRepoRelativePath('', 'file.txt#L10')).toBe('file.txt');
  });

  it('decodes percent-encoding', () => {
    expect(normalizeRepoRelativePath('', 'hello%20world.txt')).toBe('hello world.txt');
  });

  it('returns null for .. in absolute path', () => {
    expect(normalizeRepoRelativePath('', '/../etc')).toBeNull();
  });

  it('handles . and empty segments', () => {
    expect(normalizeRepoRelativePath('a//b', './c/./d.txt')).toBe('a/b/c/d.txt');
  });

  it('returns null for only dots', () => {
    expect(normalizeRepoRelativePath('', '.')).toBeNull();
  });
});

describe('contentTypeForPath', () => {
  it('returns image types', () => {
    expect(contentTypeForPath('photo.png')).toBe('image/png');
    expect(contentTypeForPath('photo.jpg')).toBe('image/jpeg');
    expect(contentTypeForPath('photo.jpeg')).toBe('image/jpeg');
    expect(contentTypeForPath('photo.gif')).toBe('image/gif');
    expect(contentTypeForPath('photo.webp')).toBe('image/webp');
    expect(contentTypeForPath('icon.svg')).toBe('application/octet-stream');
    expect(contentTypeForPath('icon.ico')).toBe('image/x-icon');
    expect(contentTypeForPath('photo.bmp')).toBe('image/bmp');
  });

  it('forces attachment for scriptable extensions', () => {
    expect(shouldForceAttachment('x.html')).toBe(true);
    expect(shouldForceAttachment('x.svg')).toBe(true);
    expect(shouldForceAttachment('x.js')).toBe(true);
    expect(shouldForceAttachment('photo.png')).toBe(false);
  });

  it('assertSafeGitArg blocks control chars and option injection', () => {
    expect(() => assertSafeGitArg('-evil', 'ref')).toThrow(/dash/);
    expect(() => assertSafeGitArg('a\nb', 'ref')).toThrow(/control/);
    expect(() => assertSafeGitArg('foo/../bar', 'path')).toThrow(/traversal/);
    expect(assertSafeGitArg('main', 'ref')).toBe('main');
    expect(assertSafeGitArg('path with spaces/file.txt', 'path')).toBe(
      'path with spaces/file.txt'
    );
  });

  it('returns text types with charset', () => {
    expect(contentTypeForPath('readme.txt')).toBe('text/plain; charset=utf-8');
    expect(contentTypeForPath('readme.md')).toBe('text/markdown; charset=utf-8');
  });

  it('never serves active content as browsable HTML/JS/CSS', () => {
    // XSS mitigation: HTML/JS/CSS forced to octet-stream
    expect(contentTypeForPath('styles.css')).toBe('application/octet-stream');
    expect(contentTypeForPath('app.js')).toBe('application/octet-stream');
    expect(contentTypeForPath('page.html')).toBe('application/octet-stream');
    expect(contentTypeForPath('page.htm')).toBe('application/octet-stream');
    // SVG keeps image type for <img> embedding but shouldForceAttachment
    expect(contentTypeForPath('icon.svg')).toBe('application/octet-stream');
  });

  it('returns application types', () => {
    expect(contentTypeForPath('doc.pdf')).toBe('application/pdf');
    expect(contentTypeForPath('data.json')).toBe('application/json');
  });

  it('returns video types', () => {
    expect(contentTypeForPath('video.mp4')).toBe('video/mp4');
    expect(contentTypeForPath('video.webm')).toBe('video/webm');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(contentTypeForPath('file.xyz')).toBe('application/octet-stream');
    expect(contentTypeForPath('Makefile')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extension', () => {
    expect(contentTypeForPath('PHOTO.PNG')).toBe('image/png');
    expect(contentTypeForPath('README.MD')).toBe('text/markdown; charset=utf-8');
  });

  it('handles nested paths', () => {
    expect(contentTypeForPath('a/b/c/photo.png')).toBe('image/png');
    expect(contentTypeForPath('a/b/c/styles.css')).toBe('application/octet-stream');
  });
});

describe('isRemoteMissingError', () => {
  it('detects "repository not found"', () => {
    expect(isRemoteMissingError('fatal: repository not found')).toBe(true);
  });

  it('detects "remote: not found"', () => {
    expect(isRemoteMissingError('Error: remote: not found')).toBe(true);
  });

  it('detects "does not exist"', () => {
    expect(isRemoteMissingError('The project does not exist anymore')).toBe(true);
  });

  it('detects "could not read from remote"', () => {
    expect(isRemoteMissingError('fatal: could not read from remote repository')).toBe(true);
  });

  it('detects 404 errors', () => {
    expect(isRemoteMissingError('The requested URL returned error: 404')).toBe(true);
    expect(isRemoteMissingError('HTTP 404 Not Found')).toBe(true);
    expect(isRemoteMissingError('status code 404')).toBe(true);
    expect(isRemoteMissingError('404 Not Found')).toBe(true);
  });

  it('detects "project not found"', () => {
    expect(isRemoteMissingError('GitLab project not found')).toBe(true);
  });

  it('detects fatal not found patterns', () => {
    expect(isRemoteMissingError('fatal: something not found')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRemoteMissingError('Repository Not Found')).toBe(true);
    expect(isRemoteMissingError('404 Not Found')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isRemoteMissingError('Connection timed out')).toBe(false);
    expect(isRemoteMissingError('Permission denied')).toBe(false);
    expect(isRemoteMissingError('')).toBe(false);
  });

  it('handles multiline strings', () => {
    expect(
      isRemoteMissingError(
        'From https://github.com/org/repo\nfatal: remote repository not found'
      )
    ).toBe(true);
  });
});

describe('getMirrorPath', () => {
  it('returns shared public path', () => {
    const result = getMirrorPath('github', 'acme', 'myrepo', { isPrivate: false });
    expect(result).toContain(path.join('mirrors', 'github', 'acme', 'myrepo.git'));
  });

  it('returns private path with user segment', () => {
    const result = getMirrorPath('github', 'acme', 'myrepo', {
      isPrivate: true,
      userId: 'user-99',
    });
    expect(result).toContain(path.join('mirrors', 'users', 'user-99'));
    expect(result.endsWith(path.join('github', 'acme', 'myrepo.git'))).toBe(true);
  });

  it('defaults to public when options omitted', () => {
    const result = getMirrorPath('github', 'acme', 'myrepo');
    expect(result).toContain(path.join('mirrors', 'github', 'acme', 'myrepo.git'));
    expect(result).not.toContain('users');
  });

  it('handles back-compat string userId', () => {
    const result = getMirrorPath('github', 'acme', 'myrepo', 'legacy-user');
    expect(result).toContain(path.join('mirrors', 'github', 'acme', 'myrepo.git'));
  });
});
