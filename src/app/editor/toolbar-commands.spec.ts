import { describe, expect, it } from 'vitest';

import { applyAction, imageAltFromFileName, nextFootnoteNumber } from './toolbar-commands';

/** Applies an action and returns [newText, selFrom, selTo]. */
function run(text: string, from: number, to: number, action: Parameters<typeof applyAction>[3]) {
  const edit = applyAction(text, from, to, action);
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return [next, edit.selFrom, edit.selTo] as const;
}

describe('setHeading', () => {
  it('adds an H1 to body text', () => {
    expect(run('hello', 0, 0, { kind: 'heading', level: 1 })[0]).toBe('# hello');
  });

  it('toggles an H1 back to body', () => {
    expect(run('# hello', 2, 2, { kind: 'heading', level: 1 })[0]).toBe('hello');
  });

  it('relevels H2 to H3', () => {
    expect(run('## hi', 1, 1, { kind: 'heading', level: 3 })[0]).toBe('### hi');
  });

  it('applies to every touched line and keeps the selection on the text', () => {
    const [text, selFrom, selTo] = run('aaa\nbbb', 1, 5, { kind: 'heading', level: 2 });
    expect(text).toBe('## aaa\n## bbb');
    // The original "aa\nb" region maps through the added prefixes.
    expect(text.slice(selFrom, selTo)).toBe('aa\n## b');
  });

  it('keeps indentation', () => {
    expect(run('  deep', 2, 2, { kind: 'heading', level: 1 })[0]).toBe('  # deep');
  });
});

describe('toggleList', () => {
  it('adds a bullet and toggles it off again', () => {
    expect(run('x', 0, 0, { kind: 'list', style: 'bullet' })[0]).toBe('- x');
    expect(run('- x', 1, 1, { kind: 'list', style: 'bullet' })[0]).toBe('x');
  });

  it('numbers ordered items sequentially across the selection', () => {
    const [text] = run('a\nb\nc', 0, 5, { kind: 'list', style: 'ordered' });
    expect(text).toBe('1. a\n2. b\n3. c');
  });

  it('converts a bullet into a task', () => {
    expect(run('- a', 1, 1, { kind: 'list', style: 'task' })[0]).toBe('- [ ] a');
  });

  it('toggles a task off', () => {
    expect(run('- [ ] a', 1, 1, { kind: 'list', style: 'task' })[0]).toBe('a');
  });

  it('normalizes an asterisk bullet to a dash before toggling', () => {
    expect(run('* a', 1, 1, { kind: 'list', style: 'bullet' })[0]).toBe('- a');
  });
});

describe('wrapInline', () => {
  it('wraps the selection', () => {
    const [text, selFrom, selTo] = run('w ord', 2, 5, { kind: 'wrap', marker: '**' });
    expect(text).toBe('w **ord**');
    expect(text.slice(selFrom, selTo)).toBe('**ord**');
  });

  it('unwraps an already wrapped selection', () => {
    const [text, selFrom, selTo] = run('**ord**', 0, 7, { kind: 'wrap', marker: '**' });
    expect(text).toBe('ord');
    expect(text.slice(selFrom, selTo)).toBe('ord');
  });

  it('drops an empty pair and parks the caret inside', () => {
    const [text, selFrom, selTo] = run('a b', 2, 2, { kind: 'wrap', marker: '**' });
    // '**' + '**' inserted at 2 -> 'a ****b', caret between the two pairs
    expect(text).toBe('a ****b');
    expect(selFrom).toBe(4);
    expect(selTo).toBe(4);
  });
});

describe('makeLink', () => {
  it('wraps the selection and selects the URL placeholder', () => {
    const [text, selFrom, selTo] = run('docs', 0, 4, { kind: 'link' });
    expect(text).toBe('[docs](https://)');
    expect(text.slice(selFrom, selTo)).toBe('https://');
  });

  it('with no selection inserts an empty label', () => {
    const [text, selFrom, selTo] = run('see here', 4, 4, { kind: 'link' });
    expect(text).toBe('see [](https://)here');
    expect(text.slice(selFrom, selTo)).toBe('https://');
  });
});

describe('insertTable', () => {
  it('places a table block after the caret line and selects the first header', () => {
    const [text, selFrom, selTo] = run('intro', 3, 3, { kind: 'table', rows: 3, cols: 2 });
    expect(text).toBe('intro\n| Header 1 | Header 2 |\n| --- | --- |\n|   |   |\n|   |   |\n');
    expect(text.slice(selFrom, selTo)).toBe('Header 1');
  });

  it('appends after a last line without trailing newline', () => {
    const [text] = run('end', 3, 3, { kind: 'table', rows: 2, cols: 1 });
    expect(text.startsWith('end\n| Header 1 |')).toBe(true);
  });
});

describe('insertImage', () => {
  const image = { kind: 'image', alt: 'diagram', url: 'attachments/diagram.png' } as const;

  it('places the image as its own line after the caret line, caret at its end', () => {
    const [text, selFrom, selTo] = run('intro\nnext', 2, 2, image);
    expect(text).toBe('intro\n![diagram](attachments/diagram.png)\nnext');
    expect(selFrom).toBe('intro\n![diagram](attachments/diagram.png)'.length);
    expect(selTo).toBe(selFrom);
  });

  it('appends after a last line without trailing newline', () => {
    const [text] = run('end', 3, 3, image);
    expect(text).toBe('end\n![diagram](attachments/diagram.png)\n');
  });

  it('inserts into an empty document', () => {
    expect(run('', 0, 0, image)[0]).toBe('\n![diagram](attachments/diagram.png)\n');
  });
});

describe('toggleQuote', () => {
  it('adds and removes the > prefix', () => {
    expect(run('quoted text', 4, 4, { kind: 'quote' })[0]).toBe('> quoted text');
    expect(run('> quoted text', 4, 4, { kind: 'quote' })[0]).toBe('quoted text');
  });

  it('wraps a list line without losing its marker', () => {
    expect(run('- item', 2, 2, { kind: 'quote' })[0]).toBe('> - item');
    expect(run('> - item', 2, 2, { kind: 'quote' })[0]).toBe('- item');
  });

  it('applies to every touched line; unquoting leaves a non-quoted line alone', () => {
    expect(run('a\nb', 0, 3, { kind: 'quote' })[0]).toBe('> a\n> b');
    expect(run('> a\nb', 0, 4, { kind: 'quote' })[0]).toBe('a\nb');
  });

  it('keeps indentation and deepens a quote on a middle line', () => {
    expect(run('  deep', 3, 3, { kind: 'quote' })[0]).toBe('  > deep');
    expect(run('a\n> b', 0, 4, { kind: 'quote' })[0]).toBe('> a\n> > b');
  });
});

describe('insertFence', () => {
  it('places an empty fence block after the caret line with the caret inside', () => {
    const [text, selFrom, selTo] = run('intro\nnext', 2, 2, { kind: 'fence' });
    expect(text).toBe('intro\n```\n\n```\nnext');
    expect(selFrom).toBe('intro\n```'.length + 1);
    expect(selTo).toBe(selFrom);
  });

  it('appends after a last line without trailing newline', () => {
    const [text] = run('end', 3, 3, { kind: 'fence' });
    expect(text).toBe('end\n```\n\n```\n');
  });
});

describe('insertDivider', () => {
  it('separates from a paragraph with a blank line (a bare --- would be a setext heading)', () => {
    expect(run('para\nnext', 2, 2, { kind: 'divider' })[0]).toBe('para\n\n---\nnext');
  });

  it('replaces an empty line in place', () => {
    expect(run('a\n\nb', 2, 2, { kind: 'divider' })[0]).toBe('a\n---\nb');
  });
});

describe('extended wraps (M72)', () => {
  it('highlight wraps and unwraps ==…==', () => {
    const [text, selFrom, selTo] = run('a key point', 2, 5, { kind: 'highlight' });
    expect(text).toBe('a ==key== point');
    expect(text.slice(selFrom, selTo)).toBe('==key==');
    const [plain] = run('a ==key== point', 2, 9, { kind: 'highlight' });
    expect(plain).toBe('a key point');
  });

  it('subscript and superscript toggle their single markers', () => {
    expect(run('H2O', 1, 2, { kind: 'subscript' })[0]).toBe('H~2~O');
    expect(run('H~2~O', 1, 4, { kind: 'subscript' })[0]).toBe('H2O');
    expect(run('X2', 1, 2, { kind: 'superscript' })[0]).toBe('X^2^');
    expect(run('X^2^', 1, 4, { kind: 'superscript' })[0]).toBe('X2');
  });

  it('inline math wraps $…$ and parks the caret between a bare pair', () => {
    expect(run('E equals', 0, 1, { kind: 'mathInline' })[0]).toBe('$E$ equals');
    const [empty] = run('a b', 2, 2, { kind: 'mathInline' });
    expect(empty).toBe('a $$b');
    const [, selFrom, selTo] = run('a b', 2, 2, { kind: 'mathInline' });
    expect(selFrom).toBe(3);
    expect(selTo).toBe(3);
  });
});

describe('insertMathBlock', () => {
  it('places an empty $$ block after the caret line with the caret inside', () => {
    const [text, selFrom, selTo] = run('intro\nnext', 2, 2, { kind: 'mathBlock' });
    expect(text).toBe('intro\n$$\n\n$$\nnext');
    expect(selFrom).toBe('intro\n$$\n'.length);
    expect(selTo).toBe(selFrom);
  });

  it('appends after a last line without trailing newline', () => {
    expect(run('end', 3, 3, { kind: 'mathBlock' })[0]).toBe('end\n$$\n\n$$\n');
  });
});

describe('toggleCallout', () => {
  it('quotes plain lines and lands the marker line on top', () => {
    const [text, selFrom, selTo] = run('watch out', 3, 3, { kind: 'callout', variant: 'warning' });
    expect(text).toBe('> [!WARNING]\n> watch out');
    // The caret keeps its offset into the body, below the marker line.
    expect(text.slice(selFrom, selTo)).toBe('');
    expect(selFrom).toBe('> [!WARNING]\n> wat'.length);
  });

  it('adds a marker to an existing plain blockquote', () => {
    expect(run('> plain\n> quote', 3, 3, { kind: 'callout', variant: 'tip' })[0]).toBe(
      '> [!TIP]\n> plain\n> quote',
    );
  });

  it('removes the marker line when the same kind is applied again', () => {
    expect(run('> [!NOTE]\n> body', 4, 4, { kind: 'callout', variant: 'note' })[0]).toBe('> body');
  });

  it('swaps the keyword when another kind is applied', () => {
    expect(run('> [!NOTE]\n> body', 4, 4, { kind: 'callout', variant: 'caution' })[0]).toBe(
      '> [!CAUTION]\n> body',
    );
  });

  it('recognises the marker from any line of the block, not just the first', () => {
    // The caret sits on the block's second line; the marker above it is
    // still the one toggled off.
    expect(run('> [!NOTE]\n> body', 12, 12, { kind: 'callout', variant: 'note' })[0]).toBe('> body');
  });

  it('strips an Obsidian fold suffix when switching the kind', () => {
    expect(run('> [!NOTE]- folded', 4, 4, { kind: 'callout', variant: 'tip' })[0]).toBe(
      '> [!TIP]- folded',
    );
  });

  it('quotes every touched line of a multi-line selection', () => {
    expect(run('a\nb', 0, 3, { kind: 'callout', variant: 'note' })[0]).toBe(
      '> [!NOTE]\n> a\n> b',
    );
  });
});

describe('insertFootnote', () => {
  it('plants the ref after the selection and the definition at the doc end', () => {
    const [text, selFrom, selTo] = run('a claim here', 0, 1, { kind: 'footnote' });
    expect(text).toBe('a[^1] claim here\n\n[^1]: Footnote');
    expect(text.slice(selFrom, selTo)).toBe('Footnote');
  });

  it('numbers past the highest existing definition', () => {
    const [text] = run('x[^7] y\n\n[^7]: old', 7, 7, { kind: 'footnote' });
    expect(text).toBe('x[^7] y[^8]\n\n[^7]: old\n\n[^8]: Footnote');
  });

  it('keeps trailing newlines from doubling the definition block', () => {
    const [text] = run('text\n', 4, 4, { kind: 'footnote' });
    expect(text).toBe('text[^1]\n\n[^1]: Footnote');
  });

  it('backs a line-selection (ending past the break) onto the paragraph', () => {
    // A triple-click selects through to the next line's start; the ref
    // belongs after the last character, not alone on the following line.
    const [text, selFrom, selTo] = run('a claim\nnext', 0, 8, { kind: 'footnote' });
    expect(text).toBe('a claim[^1]\nnext\n\n[^1]: Footnote');
    expect(text.slice(selFrom, selTo)).toBe('Footnote');
  });
});

describe('nextFootnoteNumber', () => {
  it('starts at 1 and steps past the highest number', () => {
    expect(nextFootnoteNumber('')).toBe(1);
    expect(nextFootnoteNumber('a[^2]: nope\n\n[^2]: x')).toBe(3);
    expect(nextFootnoteNumber('ref[^10] and [^9]:\n\n[^9]: a\n[^10]: b')).toBe(11);
  });

  it('ignores non-numeric labels', () => {
    expect(nextFootnoteNumber('[^prologue]: x')).toBe(1);
  });
});


describe('imageAltFromFileName', () => {
  it('drops the extension', () => {
    expect(imageAltFromFileName('screen shot.png')).toBe('screen shot');
  });

  it('replaces characters that break the alt or read as a size', () => {
    expect(imageAltFromFileName('a[1]|300.jpg')).toBe('a 1 300');
  });

  it('keeps dot files and falls back to "image"', () => {
    expect(imageAltFromFileName('.hidden')).toBe('.hidden');
    expect(imageAltFromFileName('[].png')).toBe('image');
  });
});
