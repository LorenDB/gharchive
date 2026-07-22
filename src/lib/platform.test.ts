import { describe, expect, it } from 'vitest';
import {
  defaultCloneUrl,
  hostForPlatform,
  isGithub,
  knownApiKind,
  platformDisplay,
  platformFromHost,
  platformUrl,
  remoteWebUrl,
  repoRemoteUrl,
} from '@/lib/platform';

describe('platformDisplay', () => {
  it('maps known platforms', () => {
    expect(platformDisplay('github')).toBe('GitHub');
    expect(platformDisplay('gitlab')).toBe('GitLab');
    expect(platformDisplay('codeberg')).toBe('Codeberg');
  });

  it('title-cases unknown short platforms', () => {
    expect(platformDisplay('gitea')).toBe('Gitea');
  });

  it('shows hostnames as-is', () => {
    expect(platformDisplay('git.example.com')).toBe('git.example.com');
  });

  it('handles empty', () => {
    expect(platformDisplay(null)).toBe('Remote');
    expect(platformDisplay(undefined)).toBe('Remote');
    expect(platformDisplay('')).toBe('Remote');
  });
});

describe('platformUrl', () => {
  it('builds github, gitlab, and codeberg URLs', () => {
    expect(platformUrl('github', 'acme', 'widget')).toBe(
      'https://github.com/acme/widget'
    );
    expect(platformUrl('gitlab', 'group', 'project')).toBe(
      'https://gitlab.com/group/project'
    );
    expect(platformUrl('codeberg', 'acme', 'widget')).toBe(
      'https://codeberg.org/acme/widget'
    );
  });

  it('builds URLs for hostname-as-platform', () => {
    expect(platformUrl('git.example.com', 'a', 'b')).toBe(
      'https://git.example.com/a/b'
    );
  });

  it('returns null for empty platform', () => {
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
    expect(remoteWebUrl('https://codeberg.org/o/r.git')).toBe(
      'https://codeberg.org/o/r'
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
    expect(isGithub('codeberg')).toBe(false);
    expect(isGithub(null)).toBe(false);
  });
});

describe('platformFromHost / hostForPlatform / knownApiKind', () => {
  it('maps known hosts', () => {
    expect(platformFromHost('github.com')).toBe('github');
    expect(platformFromHost('www.gitlab.com')).toBe('gitlab');
    expect(platformFromHost('codeberg.org')).toBe('codeberg');
    expect(platformFromHost('git.example.com')).toBe('git.example.com');
  });

  it('maps platforms back to hosts', () => {
    expect(hostForPlatform('github')).toBe('github.com');
    expect(hostForPlatform('codeberg')).toBe('codeberg.org');
    expect(hostForPlatform('git.example.com')).toBe('git.example.com');
  });

  it('knows API kinds', () => {
    expect(knownApiKind('github')).toBe('github');
    expect(knownApiKind('gitlab')).toBe('gitlab');
    expect(knownApiKind('codeberg')).toBe('forgejo');
    expect(knownApiKind('git.example.com')).toBe('none');
  });

  it('builds default clone URLs', () => {
    expect(defaultCloneUrl('codeberg', 'o', 'r')).toBe(
      'https://codeberg.org/o/r.git'
    );
    expect(defaultCloneUrl('git.example.com', 'o', 'r')).toBe(
      'https://git.example.com/o/r.git'
    );
  });
});
