import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { highlightCode } from './code-highlight';

describe('highlightCode (ui.highlightCode)', () => {
  const style = HighlightStyle.define([{ tag: t.keyword, color: 'red' }]);

  it('colours a known language and keeps the text intact', async () => {
    const code = 'const n = 1;';
    const spans = await highlightCode(code, 'ts', style);
    expect(spans).not.toBeNull();
    expect(spans!.map((s) => s.text).join('')).toBe(code);
    const keyword = spans!.find((s) => s.text === 'const');
    expect(keyword?.className).not.toBe('');
  });

  it('resolves aliases and file extensions', async () => {
    expect(await highlightCode('x = 1', 'python', style)).not.toBeNull();
    expect(await highlightCode('{}', 'json', style)).not.toBeNull();
  });

  it('returns null for an unknown or empty language', async () => {
    expect(await highlightCode('x', 'definitely-not-a-language', style)).toBeNull();
    expect(await highlightCode('x', '', style)).toBeNull();
  });
});
