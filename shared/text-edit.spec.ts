import { describe, expect, it } from 'vitest';
import { applyTextEdits } from './text-edit';

const DOC = ['# Harbour', '', 'Fee: 10', 'Open: daily', '', 'Fee: 10'].join('\n');

const error = (...args: Parameters<typeof applyTextEdits>): string => {
  const result = applyTextEdits(...args);
  return result.ok ? '' : result.error;
};

describe('applyTextEdits', () => {
  it('replaces text that occurs once and reports its line', () => {
    expect(applyTextEdits(DOC, [{ oldText: 'Open: daily', newText: 'Open: weekdays' }])).toEqual({
      ok: true,
      text: DOC.replace('Open: daily', 'Open: weekdays'),
      replacements: 1,
      lines: [4],
    });
  });

  it('applies edits in order, a later one building on an earlier one', () => {
    const result = applyTextEdits(DOC, [
      { oldText: 'Open: daily', newText: 'Open: weekdays' },
      { oldText: 'weekdays', newText: 'Mon–Fri' },
    ]);
    expect(result.ok && result.text).toContain('Open: Mon–Fri');
  });

  it('refuses text that is not there, with the edit named', () => {
    expect(error(DOC, [{ oldText: 'Closed', newText: 'x' }])).toBe(
      'Error: The edit: old_text "Closed" was not found — nothing was changed. Read the file again and copy the text exactly; it may have changed.',
    );
    expect(
      error(DOC, [
        { oldText: 'Open: daily', newText: 'x' },
        { oldText: 'Closed', newText: 'y' },
      ]),
    ).toMatch(/^Error: Edit 2: old_text "Closed" was not found/);
  });

  it('says when only the whitespace differs', () => {
    expect(error(DOC, [{ oldText: 'Fee: 10\n\nOpen: daily', newText: 'x' }])).toContain(
      'spaces or line breaks differ',
    );
  });

  it('says when the line numbers of a listing were copied along', () => {
    expect(error(DOC, [{ oldText: '4: Open: daily', newText: 'x' }])).toContain(
      'send the text without them',
    );
  });

  it('refuses ambiguous text and lists where it occurs', () => {
    expect(error(DOC, [{ oldText: 'Fee: 10', newText: 'Fee: 12' }])).toBe(
      'Error: The edit: old_text "Fee: 10" occurs 2 times (lines 3, 6) — nothing was changed. Add surrounding lines so it matches once, or set replace_all to change every occurrence.',
    );
  });

  it('replaces every occurrence with replaceAll', () => {
    const result = applyTextEdits(DOC, [{ oldText: 'Fee: 10', newText: 'Fee: 12', replaceAll: true }]);
    expect(result).toMatchObject({ ok: true, replacements: 2, lines: [3, 6] });
    expect(result.ok && result.text).not.toContain('Fee: 10');
  });

  it('treats a replacement that holds `$` as plain text', () => {
    const result = applyTextEdits('price', [{ oldText: 'price', newText: '$& and $1' }]);
    expect(result.ok && result.text).toBe('$& and $1');
  });

  it('refuses an empty old_text, an edit that changes nothing, and no edits at all', () => {
    expect(error(DOC, [{ oldText: '', newText: 'x' }])).toContain('empty old_text');
    expect(error(DOC, [{ oldText: 'Open', newText: 'Open' }])).toContain('with the same text');
    expect(error(DOC, [])).toContain('no edits were given');
  });

  it('shortens a long first line when it quotes it', () => {
    expect(error(DOC, [{ oldText: 'x'.repeat(200), newText: 'y' }])).toContain(`"${'x'.repeat(80)}…"`);
  });
});
