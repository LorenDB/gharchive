import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import {
  AUTOLOGIN_USER_ID,
  safeUserPathSegment,
  tryGetUserId,
} from '@/lib/user-context';
import { hasEnoughMemory } from '@/lib/memory';

const execAsync = promisify(execCb);

function getMirrorsDir(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'mirrors');
}

function run(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { encoding: 'utf8', cwd, maxBuffer: 10 * 1024 * 1024 });
}

function assertMemory(label: string): void {
  const check = hasEnoughMemory(128);
  if (!check.ok) {
    throw new Error(`Insufficient memory for ${label}: ${check.reason}`);
  }
}

const MAX_PATH_SEGMENT = 255;

export function assertSafePathSegment(segment: string, label: string): string {
  if (!segment || typeof segment !== 'string') {
    throw new Error(`Invalid ${label}: empty`);
  }
  if (segment.length > MAX_PATH_SEGMENT) {
    throw new Error(`Invalid ${label}: too long`);
  }
  if (
    segment.includes('..') ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
    throw new Error(`Invalid ${label}: unsafe path segment`);
  }
  if (/[\0\n\r;|&$`"' ]/.test(segment)) {
    throw new Error(`Invalid ${label}: unsafe characters`);
  }
  if (segment.startsWith('-')) {
    throw new Error(`Invalid ${label}: starts with dash`);
  }
  return segment;
}

export type MirrorPathOptions = {
  /** Private archives are isolated per user; public use a shared path. */
  isPrivate?: boolean;
  userId?: string;
};

/**
 * On-disk path for a bare mirror.
 * - Public (shared): `mirrors/{platform}/{owner}/{name}.git`
 * - Private: `mirrors/users/{userId}/{platform}/{owner}/{name}.git`
 */
export function getMirrorPath(
  platform: string,
  owner: string,
  name: string,
  options?: MirrorPathOptions | string
): string {
  const safePlatform = assertSafePathSegment(platform, 'platform');
  const safeOwner = assertSafePathSegment(owner, 'owner');
  const safeName = assertSafePathSegment(name.replace(/\.git$/, ''), 'name');
  const opts: MirrorPathOptions =
    typeof options === 'string' ? { userId: options } : options || {};
  const isPrivate = Boolean(opts.isPrivate);
  const mirrorsDir = getMirrorsDir();
  if (!isPrivate) {
    return path.join(mirrorsDir, safePlatform, safeOwner, safeName + '.git');
  }
  const uid = opts.userId ?? tryGetUserId() ?? AUTOLOGIN_USER_ID;
  return path.join(
    mirrorsDir,
    'users',
    safeUserPathSegment(uid),
    safePlatform,
    safeOwner,
    safeName + '.git'
  );
}

function looksLikeBareRepo(mirrorPath: string): boolean {
  return (
    fs.existsSync(path.join(mirrorPath, 'HEAD')) &&
    fs.existsSync(path.join(mirrorPath, 'objects')) &&
    fs.existsSync(path.join(mirrorPath, 'refs'))
  );
}

/**
 * Clone a bare mirror. Uses a temporary directory + atomic rename to avoid
 * TOCTOU races and serializes via withMirrorLock so concurrent requests
 * for the same path never clash.
 */
export async function cloneMirror(
  cloneUrl: string,
  mirrorPath: string
): Promise<{ reused: boolean }> {
  return withMirrorLock(mirrorPath, async () => {
    assertMemory(`clone ${cloneUrl}`);
    assertSafeGitArg(cloneUrl, 'clone_url');
    assertSafeGitArg(mirrorPath, 'mirror_path');
    const dir = path.dirname(mirrorPath);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(mirrorPath)) {
      if (looksLikeBareRepo(mirrorPath)) {
        await applyGcProtection(mirrorPath);
        return { reused: true };
      }
      fs.rmSync(mirrorPath, { recursive: true, force: true });
    }

    const tmpDir = path.join(
      dir,
      `.tmp-clone-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await run(`git clone --bare --mirror "${cloneUrl}" "${tmpDir}"`);
      try {
        fs.renameSync(tmpDir, mirrorPath);
      } catch (renameErr: any) {
        if (fs.existsSync(mirrorPath) && looksLikeBareRepo(mirrorPath)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          await applyGcProtection(mirrorPath);
          return { reused: true };
        }
        throw renameErr;
      }
      await applyGcProtection(mirrorPath);
      return { reused: false };
    } catch (err) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  });
}

/** Serialize concurrent git ops on the same bare mirror path. */
const mirrorLocks = new Map<string, Promise<unknown>>();

export async function withMirrorLock<T>(
  mirrorPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = path.resolve(mirrorPath);
  const prev = mirrorLocks.get(key) || Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => {
    resolveNext = r;
  });
  // Chain: wait for prev, then hold until we finish
  const held = prev.catch(() => {}).then(() => next);
  mirrorLocks.set(key, held);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    resolveNext();
    setTimeout(() => {
      if (mirrorLocks.get(key) === held) mirrorLocks.delete(key);
    }, 0);
  }
}

async function applyGcProtection(mirrorPath: string): Promise<void> {
  assertSafeGitArg(mirrorPath, 'mirror_path');
  const settings = [
    'gc.auto 0',
    'gc.pruneExpire never',
    'gc.reflogExpire never',
    'gc.reflogExpireUnreachable never',
    'core.logAllRefUpdates always',
  ];
  for (const setting of settings) {
    await run(`git -C "${mirrorPath}" config ${setting}`);
  }
}

export async function verifyGcProtection(mirrorPath: string): Promise<void> {
  await applyGcProtection(mirrorPath);
}

export interface MirrorSyncResult {
  message: string;
  /** True when remote appears gone (404 / not found). */
  repoDeleted: boolean;
  /** True when history was force-rewritten or heads/tags mass-deleted. */
  historyWiped: boolean;
  historyDetails: string[];
}

export async function syncMirror(mirrorPath: string): Promise<MirrorSyncResult> {
  assertMemory(`sync ${mirrorPath}`);
  await verifyGcProtection(mirrorPath);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const snapshotNs = `refs/archive/${timestamp}`;

  const beforeHeads = await listRefTips(mirrorPath, 'refs/heads/');
  const beforeTags = await listRefTips(mirrorPath, 'refs/tags/');

  try {
    const refList = [
      ...Object.keys(beforeHeads).map((n) => `refs/heads/${n}`),
      ...Object.keys(beforeTags).map((n) => `refs/tags/${n}`),
    ];
    for (const ref of refList) {
      const shortRef = ref.replace(/^refs\//, '');
      try {
        await run(`git -C "${mirrorPath}" update-ref "${snapshotNs}/${shortRef}" "${ref}"`);
      } catch {
        // skip individual ref snapshot failures
      }
    }
  } catch {
    // no refs to snapshot (e.g. empty repo)
  }

  let stdout = '';
  let stderr = '';
  try {
    const result = await run(
      `git -C "${mirrorPath}" fetch origin '+refs/*:refs/*'`
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    const msg = `${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || err}`;
    if (isRemoteMissingError(msg)) {
      return {
        message: msg.trim() || 'remote repository not found',
        repoDeleted: true,
        historyWiped: false,
        historyDetails: [],
      };
    }
    throw err;
  }

  const afterHeads = await listRefTips(mirrorPath, 'refs/heads/');
  const history = await detectHistoryWipe(mirrorPath, beforeHeads, afterHeads, beforeTags);

  return {
    message: `${stdout}\n${stderr}`.trim(),
    repoDeleted: false,
    historyWiped: history.wiped,
    historyDetails: history.details,
  };
}

/** Map short ref name → tip SHA for a refs namespace. */
async function listRefTips(
  mirrorPath: string,
  prefix: string
): Promise<Record<string, string>> {
  try {
    const { stdout } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname:short)%09%(objectname)' ${prefix}`
    );
    const out: Record<string, string> = {};
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, sha] = line.split('\t');
      if (name && sha) out[name] = sha;
    }
    return out;
  } catch {
    return {};
  }
}

async function detectHistoryWipe(
  mirrorPath: string,
  beforeHeads: Record<string, string>,
  afterHeads: Record<string, string>,
  beforeTags: Record<string, string>
): Promise<{ wiped: boolean; details: string[] }> {
  const details: string[] = [];
  const beforeNames = Object.keys(beforeHeads);
  if (beforeNames.length === 0) {
    return { wiped: false, details: [] };
  }

  // Force-push / non-fast-forward: old tip is not an ancestor of new tip
  let rewritten = 0;
  for (const name of beforeNames) {
    const oldSha = beforeHeads[name];
    const newSha = afterHeads[name];
    if (!newSha) continue;
    if (oldSha === newSha) continue;
    try {
      await run(
        `git -C "${mirrorPath}" merge-base --is-ancestor "${oldSha}" "${newSha}"`
      );
      // exit 0 → fast-forward / normal advance
    } catch {
      rewritten++;
      details.push(
        `branch ${name}: non-fast-forward (${oldSha.slice(0, 8)} → ${newSha.slice(0, 8)})`
      );
    }
  }

  // Mass branch deletion
  const afterNames = Object.keys(afterHeads);
  const deletedHeads = beforeNames.filter((n) => !afterHeads[n]);
  if (
    beforeNames.length >= 2 &&
    deletedHeads.length >= Math.max(2, Math.ceil(beforeNames.length * 0.5))
  ) {
    details.push(
      `branches deleted: ${deletedHeads.length}/${beforeNames.length} (${deletedHeads.slice(0, 8).join(', ')}${deletedHeads.length > 8 ? '…' : ''})`
    );
  }

  // All heads gone while we had some
  if (beforeNames.length > 0 && afterNames.length === 0) {
    details.push(`all ${beforeNames.length} branch tip(s) removed upstream`);
  }

  // Mass tag deletion (only if we had a meaningful set)
  const beforeTagNames = Object.keys(beforeTags);
  if (beforeTagNames.length >= 5) {
    const afterTags = await listRefTips(mirrorPath, 'refs/tags/');
    const deletedTags = beforeTagNames.filter((n) => !afterTags[n]);
    if (deletedTags.length >= Math.ceil(beforeTagNames.length * 0.5)) {
      details.push(
        `tags deleted: ${deletedTags.length}/${beforeTagNames.length}`
      );
    }
  }

  const wiped =
    rewritten > 0 ||
    details.some((d) => d.startsWith('branches deleted') || d.startsWith('all '));

  // Tag mass-delete alone is also a history wipe signal
  const tagWipe = details.some((d) => d.startsWith('tags deleted'));
  return { wiped: wiped || tagWipe, details };
}

/** Heuristic: remote repo gone / access revoked. */
export function isRemoteMissingError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('repository not found') ||
    m.includes('remote: not found') ||
    m.includes('does not exist') ||
    m.includes('could not read from remote') ||
    m.includes('remote repository not found') ||
    /\bfatal:.*not found\b/.test(m) ||
    m.includes('the requested url returned error: 404') ||
    m.includes('http 404') ||
    m.includes('status code 404') ||
    m.includes('project not found') ||
    m.includes('404 not found')
  );
}

export async function deleteMirror(mirrorPath: string): Promise<void> {
  try {
    const stat = fs.lstatSync(mirrorPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to delete symlink: ${mirrorPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (fs.existsSync(mirrorPath)) {
    fs.rmSync(mirrorPath, { recursive: true, force: true });
  }
}

export async function mirrorStat(mirrorPath: string): Promise<{
  branchCount: number;
  tagCount: number;
  sizeBytes: number;
}> {
  try {
    const { stdout: branches } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname)' refs/heads/`
    );
    const branchCount = branches.trim().split('\n').filter(Boolean).length;

    const { stdout: tags } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname)' refs/tags/`
    );
    const tagCount = tags.trim().split('\n').filter(Boolean).length;

    const sizeBytes = dirSize(mirrorPath);

    return { branchCount, tagCount, sizeBytes };
  } catch {
    return { branchCount: 0, tagCount: 0, sizeBytes: 0 };
  }
}

function dirSize(dirPath: string): number {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

export async function getDefaultBranch(mirrorPath: string): Promise<string> {
  try {
    const { stdout } = await run(
      `git -C "${mirrorPath}" symbolic-ref --short HEAD`
    );
    return stdout.trim() || 'main';
  } catch {
    try {
      const { stdout } = await run(
        `git -C "${mirrorPath}" for-each-ref --format='%(refname:short)' --count=1 refs/heads/`
      );
      return stdout.trim() || 'main';
    } catch {
      return 'main';
    }
  }
}

export async function listBranches(mirrorPath: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname:short)' --sort=-committerdate refs/heads/`
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function listTags(mirrorPath: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname:short)' --sort=-creatordate refs/tags/`
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  name: string;
  size?: number;
}

/** Sanitize a ref or path segment used in git commands. */
function assertSafeGitArg(value: string, label: string): string {
  if (!value || /[\0\n\r;|&$`\\"' ]/.test(value) || value.includes('..')) {
    throw new Error(`Invalid ${label}`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${label}: starts with dash`);
  }
  return value;
}

export async function listTree(
  mirrorPath: string,
  ref: string,
  dirPath: string = ''
): Promise<TreeEntry[]> {
  const safeRef = assertSafeGitArg(ref, 'ref');
  const treeish = dirPath
    ? `${safeRef}:${assertSafeGitArg(dirPath.replace(/^\/+|\/+$/g, ''), 'path')}`
    : safeRef;

  const { stdout } = await run(
    `git -C "${mirrorPath}" ls-tree -l "${treeish}"`
  );

  const entries: TreeEntry[] = [];
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    // mode SP type SP sha SP size TAB name
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const name = line.slice(tab + 1);
    if (meta.length < 3) continue;
    const [mode, type, sha, sizeStr] = meta;
    entries.push({
      mode,
      type: type as TreeEntry['type'],
      sha,
      name,
      size: sizeStr && sizeStr !== '-' ? parseInt(sizeStr, 10) : undefined,
    });
  }

  // Directories first, then files; alphabetical within each group
  entries.sort((a, b) => {
    if (a.type === 'tree' && b.type !== 'tree') return -1;
    if (a.type !== 'tree' && b.type === 'tree') return 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export interface BlobResult {
  content: string;
  size: number;
  binary: boolean;
  encoding: 'utf-8' | 'base64';
}

const MAX_TEXT_BYTES = 512 * 1024; // 512 KB preview cap
/** Cap for raw binary serving (README images, etc.) */
const MAX_RAW_BYTES = 8 * 1024 * 1024; // 8 MB

export async function getBlob(
  mirrorPath: string,
  ref: string,
  filePath: string
): Promise<BlobResult> {
  const safeRef = assertSafeGitArg(ref, 'ref');
  const normalized = normalizeRepoRelativePath('', filePath);
  if (normalized == null) {
    throw new Error('Invalid path');
  }
  const safePath = assertSafeGitArg(normalized, 'path');
  const treeish = `${safeRef}:${safePath}`;

  const { stdout: sizeStr } = await run(
    `git -C "${mirrorPath}" cat-file -s "${treeish}"`
  );
  const size = parseInt(sizeStr.trim(), 10) || 0;

  if (size > MAX_TEXT_BYTES) {
    return {
      content: '',
      size,
      binary: true,
      encoding: 'utf-8',
    };
  }

  // Read raw bytes (binary-safe) via cat-file
  const { stdout: buffer } = await execAsync(
    `git -C "${mirrorPath}" cat-file -p "${treeish}"`,
    { encoding: 'buffer', maxBuffer: MAX_TEXT_BYTES + 1024 }
  );

  // Null-byte heuristic for binary
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  const binary = sample.includes(0);

  if (binary) {
    return {
      content: buffer.toString('base64'),
      size,
      binary: true,
      encoding: 'base64',
    };
  }

  return {
    content: buffer.toString('utf-8'),
    size,
    binary: false,
    encoding: 'utf-8',
  };
}

/**
 * Read a file from the bare mirror as raw bytes (for image serving, etc.).
 * Rejects paths that escape the tree; enforces a size cap.
 */
export async function getRawFile(
  mirrorPath: string,
  ref: string,
  filePath: string,
  maxBytes: number = MAX_RAW_BYTES
): Promise<{ buffer: Buffer; size: number }> {
  const safeRef = assertSafeGitArg(ref, 'ref');
  // Normalize path: strip leading slashes, reject traversal
  const normalized = normalizeRepoRelativePath('', filePath);
  if (normalized == null) {
    throw new Error('Invalid path');
  }
  const safePath = assertSafeGitArg(normalized, 'path');
  const treeish = `${safeRef}:${safePath}`;

  const { stdout: sizeStr } = await run(
    `git -C "${mirrorPath}" cat-file -s "${treeish}"`
  );
  const size = parseInt(sizeStr.trim(), 10) || 0;

  if (size > maxBytes) {
    throw new Error(
      `File too large to serve (${size} bytes; limit ${maxBytes})`
    );
  }

  const { stdout: buffer } = await execAsync(
    `git -C "${mirrorPath}" cat-file -p "${treeish}"`,
    { encoding: 'buffer', maxBuffer: maxBytes + 1024 }
  );

  return { buffer: buffer as Buffer, size };
}

/**
 * Resolve a path relative to a base directory inside the repo tree.
 * Returns null for absolute URLs or paths that escape the repo root.
 */
export function normalizeRepoRelativePath(
  baseDir: string,
  href: string
): string | null {
  if (!href || typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  // Absolute / special schemes — not a repo path
  if (/^(https?:|data:|blob:|cid:|mailto:|javascript:)/i.test(trimmed)) {
    return null;
  }
  // Protocol-relative
  if (trimmed.startsWith('//')) return null;

  // Strip query/hash
  let path = trimmed.split('#')[0].split('?')[0];
  if (!path) return null;

  // Decode percent-encoding (e.g. %20)
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }

  const segments: string[] = [];
  if (path.startsWith('/')) {
    // Absolute within repo
    for (const p of path.slice(1).split('/')) {
      if (p === '' || p === '.') continue;
      if (p === '..') return null;
      segments.push(p);
    }
  } else {
    for (const p of [
      ...baseDir.split('/').filter(Boolean),
      ...path.split('/'),
    ]) {
      if (p === '' || p === '.') continue;
      if (p === '..') {
        if (segments.length === 0) return null;
        segments.pop();
      } else {
        segments.push(p);
      }
    }
  }

  if (segments.length === 0) return null;
  // Disallow weird control chars already handled by assertSafeGitArg later
  return segments.join('/');
}

/** Guess Content-Type from a repo file path. */
export function contentTypeForPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
    apng: 'image/apng',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return map[ext] || 'application/octet-stream';
}

export async function getCommitInfo(
  mirrorPath: string,
  ref: string
): Promise<{ sha: string; subject: string; author: string; date: string } | null> {
  try {
    const safeRef = assertSafeGitArg(ref, 'ref');
    const { stdout } = await run(
      `git -C "${mirrorPath}" log -1 --format='%H%x00%s%x00%an%x00%cI' "${safeRef}"`
    );
    const [sha, subject, author, date] = stdout.trim().split('\0');
    if (!sha) return null;
    return { sha, subject, author, date };
  } catch {
    return null;
  }
}

/**
 * Find a README-like file at the root of `ref` and return its blob.
 * Tries common filenames in order; falls back to a case-insensitive root
 * tree scan preferring Markdown over plain text.
 */
export async function getReadmeBlob(
  mirrorPath: string,
  ref: string,
  candidates: string[]
): Promise<(BlobResult & { path: string }) | null> {
  const safeRef = assertSafeGitArg(ref, 'ref');

  for (const name of candidates) {
    try {
      const blob = await getBlob(mirrorPath, safeRef, name);
      if (!blob.binary) {
        return { ...blob, path: name };
      }
    } catch {
      // try next candidate
    }
  }

  // Case-insensitive fallback via root tree listing.
  // Prefer .md > .markdown > .mdown > bare README > .txt > .rst
  try {
    const entries = await listTree(mirrorPath, safeRef, '');
    const rank = (name: string): number => {
      const lower = name.toLowerCase();
      if (lower === 'readme.md') return 0;
      if (lower.endsWith('.markdown') || lower.endsWith('.mdown')) return 1;
      if (lower.endsWith('.md')) return 2;
      if (lower === 'readme') return 3;
      if (lower.endsWith('.txt')) return 4;
      if (lower.endsWith('.rst')) return 5;
      return 9;
    };
    const matches = entries
      .filter(
        (e) =>
          e.type === 'blob' &&
          /^readme(\.(md|markdown|mdown|rst|txt))?$/i.test(e.name)
      )
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

    for (const entry of matches) {
      try {
        const blob = await getBlob(mirrorPath, safeRef, entry.name);
        if (!blob.binary) {
          return { ...blob, path: entry.name };
        }
      } catch {
        // try next
      }
    }
  } catch {
    // no readme
  }

  return null;
}

