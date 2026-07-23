import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import zlib from 'zlib';
import { runAsUser, AUTOLOGIN_USER_ID } from '@/lib/user-context';
import {
  addRelease,
  addReleaseAsset,
  createArchive,
  getReleaseAssets,
  linkUserToArchive,
  resetDbForTests,
  warmDb,
} from '@/lib/db';
import {
  STORAGE_COMPRESS_SUFFIX,
  compressForStorage,
} from '@/lib/asset-compression';
import { migrateOneAsset } from '@/lib/asset-compression-migrate';

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharchive-migrate-'));
  process.env.DATA_DIR = tempDir;
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function seedAsset(opts: {
  name: string;
  contents: Buffer | string;
  storageCompressed?: boolean;
}): { assetId: number; filePath: string } {
  warmDb();
  const archive = createArchive({
    platform: 'github',
    owner: 'acme',
    name: 'widget',
    clone_url: 'https://github.com/acme/widget.git',
    mirror_path: path.join(tempDir, 'mirrors', 'github', 'acme', 'widget.git'),
    last_synced_at: null,
    is_private: false,
  });
  linkUserToArchive(archive.id);
  const rel = addRelease({
    archive_id: archive.id,
    tag_name: 'v1',
    name: 'v1',
    body: null,
    published_at: '2024-01-01T00:00:00Z',
  });

  const logical = path.join(
    tempDir,
    'releases',
    'github',
    'acme',
    'widget',
    'v1',
    opts.name
  );
  fs.mkdirSync(path.dirname(logical), { recursive: true });

  let filePath = logical;
  let storageCompressed = false;
  if (opts.storageCompressed) {
    filePath = logical + STORAGE_COMPRESS_SUFFIX;
    const raw =
      typeof opts.contents === 'string'
        ? Buffer.from(opts.contents)
        : opts.contents;
    fs.writeFileSync(filePath, zlib.gzipSync(raw));
    storageCompressed = true;
  } else {
    fs.writeFileSync(logical, opts.contents);
  }

  const asset = addReleaseAsset({
    release_id: rel.id,
    name: opts.name,
    content_type: 'application/octet-stream',
    size: Buffer.byteLength(
      typeof opts.contents === 'string' ? opts.contents : opts.contents
    ),
    file_path: filePath,
    download_url: null,
    storage_compressed: storageCompressed,
  });

  return { assetId: asset.id, filePath };
}

describe('migrateOneAsset', () => {
  it('compresses a compressible raw asset when target is true', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const payload = 'hello world '.repeat(400);
      const { assetId, filePath } = seedAsset({
        name: 'app.exe',
        contents: payload,
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'app.exe',
          file_path: filePath,
          storage_compressed: false,
        },
        true
      );

      expect(result.result).toBe('converted');
      expect(fs.existsSync(filePath)).toBe(false);
      const compressed = filePath + STORAGE_COMPRESS_SUFFIX;
      expect(fs.existsSync(compressed)).toBe(true);
      expect(fs.statSync(compressed).size).toBeLessThan(Buffer.byteLength(payload));

      const assets = getReleaseAssets(
        // release id is 1 in fresh db
        1
      );
      const row = assets.find((a) => a.id === assetId)!;
      expect(row.storage_compressed).toBe(true);
      expect(row.file_path).toBe(compressed);
    });
  });

  it('skips already-compressed archive formats', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const { assetId, filePath } = seedAsset({
        name: 'dist.zip',
        contents: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'dist.zip',
          file_path: filePath,
          storage_compressed: false,
        },
        true
      );

      expect(result.result).toBe('skipped');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  it('skips assets that are already storage-compressed when target is true', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const { assetId, filePath } = seedAsset({
        name: 'app.bin',
        contents: 'x'.repeat(500),
        storageCompressed: true,
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'app.bin',
          file_path: filePath,
          storage_compressed: true,
        },
        true
      );

      expect(result.result).toBe('skipped');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  it('decompresses storage-gzipped assets when target is false', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const original = 'payload data '.repeat(50);
      const { assetId, filePath } = seedAsset({
        name: 'tool.bin',
        contents: original,
        storageCompressed: true,
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'tool.bin',
          file_path: filePath,
          storage_compressed: true,
        },
        false
      );

      expect(result.result).toBe('converted');
      expect(fs.existsSync(filePath)).toBe(false);
      const logical = filePath.slice(0, -STORAGE_COMPRESS_SUFFIX.length);
      expect(fs.existsSync(logical)).toBe(true);
      expect(fs.readFileSync(logical, 'utf8')).toBe(original);

      const row = getReleaseAssets(1).find((a) => a.id === assetId)!;
      expect(row.storage_compressed).toBe(false);
      expect(row.file_path).toBe(logical);
    });
  });

  it('skips raw assets when target is false', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const { assetId, filePath } = seedAsset({
        name: 'raw.bin',
        contents: 'already raw',
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'raw.bin',
          file_path: filePath,
          storage_compressed: false,
        },
        false
      );

      expect(result.result).toBe('skipped');
    });
  });

  it('round-trips compress then decompress', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      const original = 'round trip content '.repeat(100);
      const { assetId, filePath } = seedAsset({
        name: 'lib.so',
        contents: original,
      });

      const up = migrateOneAsset(
        {
          id: assetId,
          name: 'lib.so',
          file_path: filePath,
          storage_compressed: false,
        },
        true
      );
      expect(up.result).toBe('converted');

      const row = getReleaseAssets(1).find((a) => a.id === assetId)!;
      const down = migrateOneAsset(
        {
          id: assetId,
          name: 'lib.so',
          file_path: row.file_path,
          storage_compressed: row.storage_compressed,
        },
        false
      );
      expect(down.result).toBe('converted');

      const final = getReleaseAssets(1).find((a) => a.id === assetId)!;
      expect(fs.readFileSync(final.file_path!, 'utf8')).toBe(original);
      expect(final.storage_compressed).toBe(false);
    });
  });

  it('skips when gzip does not shrink (high-entropy file stays raw)', () => {
    runAsUser(AUTOLOGIN_USER_ID, () => {
      // Nested gzip is typically already high-entropy
      const randomish = zlib.gzipSync(Buffer.alloc(8192, 0x7f));
      // compressForStorage may still shrink slightly; if it does, that's ok —
      // assert only when our helper says null.
      const wouldCompress = compressForStorage(randomish);
      const { assetId, filePath } = seedAsset({
        name: 'noise.bin',
        contents: randomish,
      });

      const result = migrateOneAsset(
        {
          id: assetId,
          name: 'noise.bin',
          file_path: filePath,
          storage_compressed: false,
        },
        true
      );

      if (wouldCompress) {
        expect(result.result).toBe('converted');
      } else {
        expect(result.result).toBe('skipped');
        expect(fs.existsSync(filePath)).toBe(true);
      }
    });
  });
});
