import { fenceLang } from './fenced-code';

describe('fenceLang', () => {
  it('returns the language token, lower-cased and trimmed', () => {
    expect(fenceLang('mermaid')).toBe('mermaid');
    expect(fenceLang('  Mermaid  ')).toBe('mermaid');
    expect(fenceLang('TypeScript')).toBe('typescript');
  });

  it('takes only the first whitespace-delimited token', () => {
    expect(fenceLang('mermaid title="Flow"')).toBe('mermaid');
    expect(fenceLang('js include-in-docs')).toBe('js');
  });

  it('is empty for a bare fence', () => {
    expect(fenceLang('')).toBe('');
    expect(fenceLang('   ')).toBe('');
  });
});
