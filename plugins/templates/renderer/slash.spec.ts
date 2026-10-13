// @vitest-environment jsdom
import { categoryOf, clip, previewCard, slashTemplateOptions } from './slash';

/**
 * The pure parts of the templates' `/` menu section (milestone 43): the
 * category label, the preview clipping and the card DOM the hover previews
 * share with the base editor's slash menu.
 */
describe('templates slash menu helpers', () => {
  it('labels a template by its first folder under the library root', () => {
    expect(categoryOf({ name: 'daily', relativePath: 'templates/daily.md' }, 'templates')).toBe(
      'General',
    );
    expect(
      categoryOf({ name: '1-1', relativePath: 'templates/meetings/weekly/1-1.md' }, 'templates'),
    ).toBe('meetings');
  });

  it('clips a long snippet to its first lines and marks the cut', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const clipped = clip(long, 3).split('\n');
    expect(clipped).toEqual(['line 1', 'line 2', 'line 3', '…']);
    expect(clip('short\n\n')).toBe('short');
  });

  it('builds the preview card as plain text (no HTML from the template)', () => {
    const card = previewCard('daily', '<b>## {{date}}</b>');
    expect(card.querySelector('.slash-preview-head')?.textContent).toBe('Preview · daily');
    expect(card.querySelector('.slash-preview-body')?.textContent).toBe('<b>## {{date}}</b>');
    expect(card.querySelector('b')).toBeNull();
  });

  it('offers only the picker row for a bare slash, direct matches for a typed name', () => {
    const templates = [
      { name: 'daily', relativePath: 'templates/daily.md' },
      { name: 'Team sync', relativePath: 'templates/meetings/Team sync.md' },
      { name: 'todo', relativePath: 'templates/todo.md' },
    ];
    expect(slashTemplateOptions(templates, '')).toEqual({ browse: true, matches: [] });
    // "t" could still become "templates": the picker row stays beside the matches.
    const t = slashTemplateOptions(templates, 't');
    expect(t.browse).toBe(true);
    expect(t.matches.map((m) => m.name)).toEqual(['Team sync', 'todo']);
    const d = slashTemplateOptions(templates, 'da');
    expect(d.browse).toBe(false);
    expect(d.matches.map((m) => m.name)).toEqual(['daily']);
    expect(slashTemplateOptions(templates, 'zzz')).toEqual({ browse: false, matches: [] });
  });
});
