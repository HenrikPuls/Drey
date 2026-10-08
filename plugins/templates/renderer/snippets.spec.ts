// @vitest-environment jsdom
import { SNIPPET_DEFAULTS as SEED_DEFAULTS } from '../../../shared/config/defaults';
import { normalizeAppConfig } from '../../../shared/config/normalize';
import { SNIPPET_DEFAULTS, expandForPreview, snippetBlocked } from './snippets';

/**
 * The pure parts of the snippet library (milestone 46): the shipped
 * defaults, the config seeding rule (missing key seeds, explicit array
 * stays), the preview expansion and the block-level caret gate.
 */
describe('templates snippet library', () => {
  it('the plugin twin of the built-ins equals the config seed (parity)', () => {
    expect(SNIPPET_DEFAULTS).toEqual(SEED_DEFAULTS);
  });

  it('ships three well-formed built-ins with unique triggers', () => {
    expect(SNIPPET_DEFAULTS.map((s) => s.trigger)).toEqual(['tbl', 'code', 'task']);
    for (const snippet of SNIPPET_DEFAULTS) {
      expect(snippet.label).not.toBe('');
      expect(snippet.template).toMatch(/\$\{/);
      expect(snippet.template).not.toContain('\r');
    }
    expect(new Set(SNIPPET_DEFAULTS.map((s) => s.trigger)).size).toBe(SNIPPET_DEFAULTS.length);
  });

  it('seeds the built-ins when the config key is missing', () => {
    const config = normalizeAppConfig({ templates: { dir: 'templates' } });
    expect(config.templates.snippets).toEqual(SNIPPET_DEFAULTS);
  });

  it('keeps an explicitly empty or user-owned library (no re-seed)', () => {
    const empty = normalizeAppConfig({ templates: { snippets: [] } });
    expect(empty.templates.snippets).toEqual([]);

    const owned = normalizeAppConfig({
      templates: {
        snippets: [
          { trigger: 'Sig ', label: 'Signature', template: '— ${1:Name}' },
          { trigger: 'tbl', label: 'My table', template: '| $0 |' },
        ],
      },
    });
    expect(owned.templates.snippets).toEqual([
      { trigger: 'sig', label: 'Signature', template: '— ${1:Name}' },
      { trigger: 'tbl', label: 'My table', template: '| $0 |' },
    ]);
  });

  it('drops malformed rows and duplicate triggers while normalizing', () => {
    const config = normalizeAppConfig({
      templates: {
        snippets: [
          { trigger: '', label: 'x', template: 'y' },
          { trigger: 'no template', label: 'x', template: '' },
          { trigger: 'bad trigger!', label: 'x', template: 'y' },
          { trigger: 'dup', label: 'first', template: 'a' },
          { trigger: 'dup', label: 'second', template: 'b' },
          'not an object',
        ],
      },
    });
    expect(config.templates.snippets).toEqual([{ trigger: 'dup', label: 'first', template: 'a' }]);
  });

  it('falls back to the trigger when the label is missing', () => {
    const config = normalizeAppConfig({
      templates: { snippets: [{ trigger: 'sig', label: '  ', template: 'x' }] },
    });
    expect(config.templates.snippets[0]?.label).toBe('sig');
  });

  it('expands tabstop syntax for the preview card', () => {
    expect(expandForPreview('| ${1:Column} | ${2:} |\n| --- | --- |')).toBe('| Column |  |\n| --- | --- |');
    expect(expandForPreview('```${1:ts}\n$0\n```')).toBe('```ts\n\n```');
  });

  it('blocks block-level structures but allows plain prose', () => {
    expect(snippetBlocked([])).toBe(false);
    expect(snippetBlocked(['Document', 'Paragraph'])).toBe(false);
    expect(snippetBlocked(['Document', 'Table', 'TableRow', 'TableCell'])).toBe(true);
    expect(snippetBlocked(['Document', 'ATXHeading2'])).toBe(true);
    expect(snippetBlocked(['Document', 'BulletList', 'ListItem'])).toBe(true);
    expect(snippetBlocked(['Document', 'Blockquote', 'Paragraph'])).toBe(true);
    expect(snippetBlocked(['Document', 'FencedCode'])).toBe(true);
    expect(snippetBlocked(['Document', 'Link'])).toBe(true);
  });
});
