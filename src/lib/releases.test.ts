import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseCloneUrl, getReleaseAssetPath } from '@/lib/releases';

describe('parseCloneUrl', () => {
  describe('GitHub HTTPS', () => {
    it('parses a simple repo URL', () => {
      const result = parseCloneUrl('https://github.com/owner/repo.git');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
      expect(result.projectPath).toBe('owner/repo');
    });

    it('parses URL without .git suffix', () => {
      const result = parseCloneUrl('https://github.com/owner/repo');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });

    it('parses URL with www prefix', () => {
      const result = parseCloneUrl('https://www.github.com/owner/repo.git');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
    });

    it('parses URL with trailing slash', () => {
      const result = parseCloneUrl('https://github.com/owner/repo/');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });
  });

  describe('GitLab HTTPS', () => {
    it('parses a simple repo URL', () => {
      const result = parseCloneUrl('https://gitlab.com/group/project.git');
      expect(result.platform).toBe('gitlab');
      expect(result.owner).toBe('group');
      expect(result.repo).toBe('project');
    });

    it('parses URL without .git suffix', () => {
      const result = parseCloneUrl('https://gitlab.com/group/project');
      expect(result.platform).toBe('gitlab');
      expect(result.owner).toBe('group');
      expect(result.repo).toBe('project');
    });
  });

  describe('GitHub SSH', () => {
    it('parses SSH URL', () => {
      const result = parseCloneUrl('git@github.com:owner/repo.git');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
      expect(result.projectPath).toBe('owner/repo');
    });

    it('parses SSH URL without .git', () => {
      const result = parseCloneUrl('git@github.com:owner/repo');
      expect(result.platform).toBe('github');
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });
  });

  describe('GitLab SSH', () => {
    it('parses SSH URL', () => {
      const result = parseCloneUrl('git@gitlab.com:group/project.git');
      expect(result.platform).toBe('gitlab');
      expect(result.owner).toBe('group');
      expect(result.repo).toBe('project');
    });
  });

  describe('error cases', () => {
    it('throws for unsupported hosts', () => {
      expect(() => parseCloneUrl('https://bitbucket.org/owner/repo.git')).toThrow(
        'Unsupported repository URL'
      );
    });

    it('throws for non-github/gitlab SSH', () => {
      expect(() => parseCloneUrl('git@git.example.com:org/repo.git')).toThrow(
        'Unsupported repository URL'
      );
    });

    it('throws for invalid URL format', () => {
      expect(() => parseCloneUrl('not-a-url')).toThrow(
        'Unsupported repository URL'
      );
    });

    it('throws for Github empty owner', () => {
      expect(() => parseCloneUrl('https://github.com//repo.git')).toThrow(
        'Invalid repo URL'
      );
    });

    it('throws for Gitlab empty owner', () => {
      expect(() => parseCloneUrl('https://gitlab.com//repo.git')).toThrow(
        'Invalid repo URL'
      );
    });
  });
});

describe('getReleaseAssetPath', () => {
  it('returns public path when isPrivate is false', () => {
    const result = getReleaseAssetPath('github', 'owner', 'repo', 'v1.0.0', 'app.zip', {
      isPrivate: false,
    });
    expect(result).toContain(path.join('releases', 'github', 'owner', 'repo', 'v1.0.0', 'app.zip'));
  });

  it('returns private path with user segment when isPrivate is true', () => {
    const result = getReleaseAssetPath('github', 'owner', 'repo', 'v1.0.0', 'app.zip', {
      isPrivate: true,
      userId: 'user-42',
    });
    expect(result).toContain(path.join('releases', 'users', 'user-42'));
    expect(result).toContain(path.join('github', 'owner', 'repo', 'v1.0.0', 'app.zip'));
  });

  it('defaults isPrivate to false when options omitted', () => {
    const result = getReleaseAssetPath('github', 'owner', 'repo', 'v1.0.0', 'app.zip');
    expect(result).toContain(path.join('releases', 'github', 'owner', 'repo'));
    expect(result).not.toContain('users');
  });

  it('handles back-compat string userId argument', () => {
    const result = getReleaseAssetPath(
      'github', 'owner', 'repo', 'v1.0.0', 'app.zip',
      'legacy-user-1'
    );
    // Back-compat: when a string is passed, it's treated as { userId: string }
    // isPrivate is false since the string doesn't have isPrivate=true
    expect(result).toContain('github');
  });
});
