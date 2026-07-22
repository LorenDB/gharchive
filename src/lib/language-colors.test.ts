import { describe, expect, it } from 'vitest';
import { languageColor } from '@/lib/language-colors';

describe('languageColor', () => {
  it('returns known linguist colors', () => {
    expect(languageColor('JavaScript')).toBe('#f1e05a');
    expect(languageColor('TypeScript')).toBe('#3178c6');
    expect(languageColor('Python')).toBe('#3572A5');
    expect(languageColor('Rust')).toBe('#dea584');
    expect(languageColor('Go')).toBe('#00ADD8');
    expect(languageColor('Ruby')).toBe('#701516');
    expect(languageColor('Java')).toBe('#b07219');
    expect(languageColor('C')).toBe('#555555');
    expect(languageColor('C++')).toBe('#f34b7d');
    expect(languageColor('C#')).toBe('#178600');
    expect(languageColor('Swift')).toBe('#F05138');
    expect(languageColor('Kotlin')).toBe('#A97BFF');
    expect(languageColor('Dart')).toBe('#00B4AB');
    expect(languageColor('Shell')).toBe('#89e051');
    expect(languageColor('YAML')).toBe('#cb171e');
    // JSON is not in the linguist map, falls back to hash-based color
    const jsonColor = languageColor('JSON');
    expect(jsonColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(jsonColor).not.toBe('#f1e05a'); // not JavaScript's color
  });

  it('returns a hex color for unknown languages', () => {
    const color = languageColor('UnknownLang');
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('is case-sensitive for lookup', () => {
    expect(languageColor('rust')).not.toBe('#dea584');
    expect(languageColor('typescript')).not.toBe('#3178c6');
  });

  it('returns deterministic colors for unknown languages', () => {
    const a = languageColor('MyCustomLang1');
    const b = languageColor('MyCustomLang1');
    expect(a).toBe(b);
  });

  it('returns different colors for different unknown languages (usually)', () => {
    const samples = new Set(
      Array.from({ length: 20 }, (_, i) => languageColor(`CustomLang${i}`))
    );
    expect(samples.size).toBeGreaterThan(1);
  });
});
