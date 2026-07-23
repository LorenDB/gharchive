/**
 * Storage-side compression for release assets.
 *
 * When enabled, assets that are not already distributed as compressed archives
 * are gzipped on disk under a `.storage.gz` suffix. Serving gunzips them back
 * to the original bytes so clients always receive the upstream asset.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** Suffix appended to the logical asset path when we store gzipped bytes. */
export const STORAGE_COMPRESS_SUFFIX = '.storage.gz';

/**
 * Extensions (lowercase, with leading dot) that already indicate a compressed
 * or archive container. Compound forms listed longest-first.
 */
const COMPRESSED_ARCHIVE_EXTENSIONS: readonly string[] = [
  // Compound tar variants
  '.tar.gz',
  '.tar.bz2',
  '.tar.xz',
  '.tar.zst',
  '.tar.lz',
  '.tar.lz4',
  '.tar.sz',
  '.tar.br',
  '.tar.Z',
  // Single / short forms
  '.tgz',
  '.tbz',
  '.tbz2',
  '.txz',
  '.tzst',
  '.gz',
  '.bz2',
  '.xz',
  '.zst',
  '.lz',
  '.lz4',
  '.lzma',
  '.br',
  '.Z',
  '.zip',
  '.7z',
  '.rar',
  '.cab',
  '.deb',
  '.rpm',
  '.apk',
  '.jar',
  '.war',
  '.ear',
  '.whl',
  '.nupkg',
  '.vsix',
  '.crx',
  '.dmg',
  '.pkg',
  '.snap',
  '.appimage',
  '.msi',
  '.msix',
  '.wim',
  '.squashfs',
  '.ipa',
  '.aab',
];

/**
 * True when the filename already looks like a compressed archive that would
 * not benefit from (or could be harmed by) an extra gzip layer.
 */
export function isAlreadyCompressedArchive(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false;
  // Strip directory components if a path is passed
  const base = path.basename(filename).toLowerCase();
  for (const ext of COMPRESSED_ARCHIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }
  return false;
}

/** On-disk path used when storage compression is applied. */
export function storageCompressedPath(logicalPath: string): string {
  return logicalPath + STORAGE_COMPRESS_SUFFIX;
}

/**
 * True when `filePath` is our storage-compressed form (ends with the suffix).
 */
export function isStorageCompressedPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return filePath.endsWith(STORAGE_COMPRESS_SUFFIX);
}

/**
 * Strip the storage suffix to recover the logical (client-facing) asset path.
 * Uncompressed paths are returned unchanged.
 */
export function logicalAssetPath(filePath: string): string {
  if (isStorageCompressedPath(filePath)) {
    return filePath.slice(0, -STORAGE_COMPRESS_SUFFIX.length);
  }
  return filePath;
}

/**
 * Whether this on-disk asset is currently stored with our storage gzip layer.
 * Prefers the DB flag; falls back to path suffix.
 */
export function isAssetStorageCompressed(
  filePath: string | null | undefined,
  storageCompressedFlag?: boolean | null
): boolean {
  if (storageCompressedFlag === true) return true;
  if (storageCompressedFlag === false) return false;
  return isStorageCompressedPath(filePath);
}

export type ResolvedAssetFile = {
  path: string;
  storageCompressed: boolean;
};

/**
 * Locate an already-downloaded asset on disk at the logical path or the
 * storage-compressed variant.
 */
export function resolveExistingAssetFile(
  logicalPath: string
): ResolvedAssetFile | null {
  try {
    if (fs.existsSync(logicalPath)) {
      return { path: logicalPath, storageCompressed: false };
    }
    const compressed = storageCompressedPath(logicalPath);
    if (fs.existsSync(compressed)) {
      return { path: compressed, storageCompressed: true };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Gzip `buffer` for storage. Returns null when compression does not shrink
 * the payload (caller should store raw bytes instead).
 */
export function compressForStorage(buffer: Buffer): Buffer | null {
  if (buffer.length === 0) return null;
  try {
    const gz = Buffer.from(zlib.gzipSync(buffer, { level: 6 }));
    if (gz.length >= buffer.length) return null;
    return gz;
  } catch {
    return null;
  }
}

/** Gunzip storage-compressed bytes back to the original asset payload. */
export function decompressFromStorage(buffer: Buffer): Buffer {
  return Buffer.from(zlib.gunzipSync(buffer));
}

/**
 * Decide whether a newly downloaded asset should be stored compressed.
 * Respects the admin toggle and skips known archive formats.
 */
export function shouldCompressAsset(
  filename: string,
  compressEnabled: boolean
): boolean {
  if (!compressEnabled) return false;
  return !isAlreadyCompressedArchive(filename);
}
