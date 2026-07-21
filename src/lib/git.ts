import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import {
  AUTOLOGIN_USER_ID,
  safeUserPathSegment,
  tryGetUserId,
} from '@/lib/user-context';

const execAsync = promisify(execCb);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const MIRRORS_DIR = path.join(DATA_DIR, 'mirrors');

function run(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { encoding: 'utf8', cwd, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * On-disk path for a bare mirror.
 * - Autologin / legacy: `mirrors/{platform}/{owner}/{name}.git`
 * - SSO users: `mirrors/users/{userId}/{platform}/{owner}/{name}.git`
 */
export function getMirrorPath(
  platform: string,
  owner: string,
  name: string,
  userId?: string
): string {
  const uid = userId ?? tryGetUserId() ?? AUTOLOGIN_USER_ID;
  if (uid === AUTOLOGIN_USER_ID) {
    return path.join(MIRRORS_DIR, platform, owner, name + '.git');
  }
  return path.join(
    MIRRORS_DIR,
    'users',
    safeUserPathSegment(uid),
    platform,
    owner,
    name + '.git'
  );
}

export async function cloneMirror(cloneUrl: string, mirrorPath: string): Promise<void> {
  const dir = path.dirname(mirrorPath);
  fs.mkdirSync(dir, { recursive: true });

  await run(`git clone --bare --mirror "${cloneUrl}" "${mirrorPath}"`);
  await applyGcProtection(mirrorPath);
}

async function applyGcProtection(mirrorPath: string): Promise<void> {
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

export async function syncMirror(mirrorPath: string): Promise<string> {
  await verifyGcProtection(mirrorPath);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const snapshotNs = `refs/archive/${timestamp}`;

  try {
    const { stdout: refs } = await run(
      `git -C "${mirrorPath}" for-each-ref --format='%(refname)' refs/heads/ refs/tags/`
    );

    const refList = refs.trim().split('\n').filter(Boolean);
    for (const ref of refList) {
      const shortRef = ref.replace(/^refs\//, '');
      await run(`git -C "${mirrorPath}" update-ref "${snapshotNs}/${shortRef}" "${ref}"`);
    }
  } catch {
    // no refs to snapshot (e.g. empty repo)
  }

  const { stdout, stderr } = await run(
    `git -C "${mirrorPath}" fetch origin '+refs/*:refs/*'`
  );

  return `${stdout}\n${stderr}`.trim();
}

export async function deleteMirror(mirrorPath: string): Promise<void> {
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
  if (!value || /[\0\n\r;|&$`\\]/.test(value) || value.includes('..')) {
    throw new Error(`Invalid ${label}`);
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

export async function getBlob(
  mirrorPath: string,
  ref: string,
  filePath: string
): Promise<BlobResult> {
  const safeRef = assertSafeGitArg(ref, 'ref');
  const safePath = assertSafeGitArg(filePath.replace(/^\/+/, ''), 'path');
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

