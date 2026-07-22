import { describe, expect, it } from 'vitest';
import {
  isGithub,
  platformDisplay,
  platformUrl,
  remoteWebUrl,
  repoRemoteUrl,
} from '@/lib/platform';

describe('platformDisplay', () => {
  it('maps known platforms', () => {
    expect(platformDisplay('github')).toBe('GitHub');
    expect(platformDisplay('gitlab')).toBe('GitLab');
  });

  it('title-cases unknown platforms', () => {
    expect(platformDisplay('gitea')).toBe('Gitea');
  });

  it('handles empty', () => {
    expect(platformDisplay(null)).toBe('Remote');
    expect(platformDisplay(undefined)).toBe('Remote');
    expect(platformDisplay('')).toBe('Remote');
  });
});

describe('platformUrl', () => {
  it('builds github and gitlab URLs', () => {
    expect(platformUrl('github', 'acme', 'widget')).toBe(
      'https://github.com/acme/widget'
    );
    expect(platformUrl('gitlab', 'group', 'project')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  it('returns null for unknown platforms', () => {
    expect(platformUrl('gitea', 'a', 'b')).toBeNull();
    expect(platformUrl(null, 'a', 'b')).toBeNull();
  });
});

describe('remoteWebUrl', () => {
  it('strips .git from https clone URLs', () => {
    expect(remoteWebUrl('https://github.com/acme/widget.git')).toBe(
      'https://github.com/acme/widget'
    );
    expect(remoteWebUrl('https://gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  it('preserves nested GitLab group paths', () => {
    expect(
      remoteWebUrl('https://gitlab.com/group/subgroup/project.git')
    ).toBe('https://gitlab.com/group/subgroup/project');
  });

  it('maps SSH clone URLs to https', () => {
    expect(remoteWebUrl('git@github.com:acme/widget.git')).toBe(
      'https://github.com/acme/widget'
    );
    expect(remoteWebUrl('git@gitlab.com:group/sub/project.git')).toBe(
      'https://gitlab.com/group/sub/project'
    );
  });

  it('returns null for empty/invalid', () => {
    expect(remoteWebUrl(null)).toBeNull();
    expect(remoteWebUrl('')).toBeNull();
    expect(remoteWebUrl('not-a-url')).toBeNull();
  });
});

describe('repoRemoteUrl', () => {
  it('prefers clone_url so GitLab nested paths and domain stay correct', () => {
    expect(
      repoRemoteUrl({
        platform: 'gitlab',
        owner: 'group',
        name: 'project',
        clone_url: 'https://gitlab.com/group/subgroup/project.git',
      })
    ).toBe('https://gitlab.com/group/subgroup/project');
  });

  it('falls back to platform + owner/name', () => {
    expect(
      repoRemoteUrl({
        platform: 'github',
        owner: 'acme',
        name: 'widget',
      })
    ).toBe('https://github.com/acme/widget');
  });
});

describe('isGithub', () => {
  it('detects github only', () => {
    expect(isGithub('github')).toBe(true);
    expect(isGithub('gitlab')).toBe(false);
    expect(isGithub(null)).toBe(false);
  });
});
