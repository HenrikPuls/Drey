// @vitest-environment jsdom
import { categoryOf, clip, previewCard } from './slash';

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
});
