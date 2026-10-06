import { describe, expect, it } from 'vitest';

import { applyAction, imageAltFromFileName } from './toolbar-commands';

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
