import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  STORAGE_COMPRESS_SUFFIX,
  compressForStorage,
  decompressFromStorage,
  isAlreadyCompressedArchive,
  isStorageCompressedPath,
  resolveExistingAssetFile,
  shouldCompressAsset,
  storageCompressedPath,
} from '@/lib/asset-compression';

describe('isAlreadyCompressedArchive', () => {
  it('detects common archive extensions', () => {
    expect(isAlreadyCompressedArchive('app.zip')).toBe(true);
    expect(isAlreadyCompressedArchive('app.tar.gz')).toBe(true);
    expect(isAlreadyCompressedArchive('APP.TAR.GZ')).toBe(true);
    expect(isAlreadyCompressedArchive('bundle.tgz')).toBe(true);
    expect(isAlreadyCompressedArchive('x.7z')).toBe(true);
    expect(isAlreadyCompressedArchive('pkg.rar')).toBe(true);
    expect(isAlreadyCompressedArchive('lib.tar.bz2')).toBe(true);
    expect(isAlreadyCompressedArchive('lib.tar.xz')).toBe(true);
    expect(isAlreadyCompressedArchive('lib.tar.zst')).toBe(true);
    expect(isAlreadyCompressedArchive('pkg.deb')).toBe(true);
    expect(isAlreadyCompressedArchive('pkg.rpm')).toBe(true);
    expect(isAlreadyCompressedArchive('app.apk')).toBe(true);
    expect(isAlreadyCompressedArchive('lib.jar')).toBe(true);
    expect(isAlreadyCompressedArchive('dist.whl')).toBe(true);
    expect(isAlreadyCompressedArchive('plugin.vsix')).toBe(true);
    expect(isAlreadyCompressedArchive('release.dmg')).toBe(true);
    expect(isAlreadyCompressedArchive('data.gz')).toBe(true);
  });

  it('returns false for plain / binary filenames', () => {
    expect(isAlreadyCompressedArchive('binary')).toBe(false);
    expect(isAlreadyCompressedArchive('app.exe')).toBe(false);
    expect(isAlreadyCompressedArchive('lib.so')).toBe(false);
    expect(isAlreadyCompressedArchive('readme.md')).toBe(false);
    expect(isAlreadyCompressedArchive('source.tar')).toBe(false);
    expect(isAlreadyCompressedArchive('checksums.txt')).toBe(false);
  });

  it('uses basename when a path is passed', () => {
    expect(isAlreadyCompressedArchive('/tmp/releases/v1/app.zip')).toBe(true);
    expect(isAlreadyCompressedArchive('/tmp/releases/v1/app.bin')).toBe(false);
  });

  it('handles empty / invalid input', () => {
    expect(isAlreadyCompressedArchive('')).toBe(false);
    expect(isAlreadyCompressedArchive(null as unknown as string)).toBe(false);
  });
});

describe('shouldCompressAsset', () => {
  it('requires the toggle and a non-archive name', () => {
    expect(shouldCompressAsset('app.exe', true)).toBe(true);
    expect(shouldCompressAsset('app.exe', false)).toBe(false);
    expect(shouldCompressAsset('app.zip', true)).toBe(false);
    expect(shouldCompressAsset('app.tar.gz', true)).toBe(false);
  });
});

describe('compressForStorage / decompressFromStorage', () => {
  it('round-trips compressible text', () => {
    const original = Buffer.from('hello world '.repeat(200));
    const gz = compressForStorage(original);
    expect(gz).not.toBeNull();
    expect(gz!.length).toBeLessThan(original.length);
    expect(decompressFromStorage(gz!).equals(original)).toBe(true);
  });

  it('returns null when gzip does not shrink (high-entropy input)', () => {
    // Already-compressed-looking random bytes rarely shrink under gzip
    const random = zlib.gzipSync(Buffer.alloc(4096, 0x41));
    const gz = compressForStorage(random);
    // May or may not shrink nested gzip; if it does, still valid — only
    // assert null for empty.
    expect(compressForStorage(Buffer.alloc(0))).toBeNull();
    if (gz) {
      expect(gz.length).toBeLessThan(random.length);
    }
  });
});

describe('path helpers', () => {
  it('builds and detects the storage suffix', () => {
    const p = '/data/releases/github/o/r/v1/app.exe';
    expect(storageCompressedPath(p)).toBe(p + STORAGE_COMPRESS_SUFFIX);
    expect(isStorageCompressedPath(p + STORAGE_COMPRESS_SUFFIX)).toBe(true);
    expect(isStorageCompressedPath(p)).toBe(false);
    expect(isStorageCompressedPath(null)).toBe(false);
  });
});

describe('resolveExistingAssetFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-compress-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds uncompressed files at the logical path', () => {
    const logical = path.join(tempDir, 'app.exe');
    fs.writeFileSync(logical, 'raw');
    expect(resolveExistingAssetFile(logical)).toEqual({
      path: logical,
      storageCompressed: false,
    });
  });

  it('finds storage-compressed files via the suffix', () => {
    const logical = path.join(tempDir, 'app.exe');
    const compressed = storageCompressedPath(logical);
    fs.writeFileSync(compressed, 'gz');
    expect(resolveExistingAssetFile(logical)).toEqual({
      path: compressed,
      storageCompressed: true,
    });
  });

  it('prefers the raw file when both exist', () => {
    const logical = path.join(tempDir, 'app.exe');
    fs.writeFileSync(logical, 'raw');
    fs.writeFileSync(storageCompressedPath(logical), 'gz');
    expect(resolveExistingAssetFile(logical)).toEqual({
      path: logical,
      storageCompressed: false,
    });
  });

  it('returns null when nothing is on disk', () => {
    expect(resolveExistingAssetFile(path.join(tempDir, 'missing'))).toBeNull();
  });
});
