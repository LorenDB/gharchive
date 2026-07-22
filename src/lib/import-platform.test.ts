import { describe, expect, it } from 'vitest';
import { resolveImportPlatform } from '@/lib/import-stars';

describe('resolveImportPlatform', () => {
  it('honors explicit platform', () => {
    expect(
      resolveImportPlatform({
        platform: 'gitlab',
        clone_url: 'https://github.com/acme/x.git',
      })
    ).toBe('gitlab');
    expect(
      resolveImportPlatform({
        platform: 'github',
        clone_url: 'https://gitlab.com/acme/x.git',
      })
    ).toBe('github');
  });

  it('infers gitlab from clone URL when platform omitted', () => {
    expect(
      resolveImportPlatform({
        clone_url: 'https://gitlab.com/Mr_Goldberg/goldberg_emulator.git',
      })
    ).toBe('gitlab');
    expect(
      resolveImportPlatform({
        clone_url: 'git@gitlab.com:group/project.git',
      })
    ).toBe('gitlab');
  });

  it('infers github from clone URL when platform omitted', () => {
    expect(
      resolveImportPlatform({
        clone_url: 'https://github.com/acme/widget.git',
      })
    ).toBe('github');
  });

  it('defaults to github when nothing is known', () => {
    expect(resolveImportPlatform({ clone_url: '' })).toBe('github');
  });
});
