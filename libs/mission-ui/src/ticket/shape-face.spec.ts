import { describe, expect, it } from 'vitest';
import { editorOf, formOf, shapeFaceOf } from './shape-face';

const BODY = [
  '## Goal',
  '',
  'Press one hotkey, speak,',
  'and get a ticket.',
  '',
  '## Decisions',
  '',
  '- Win+H is the engine;',
  '  Drey only opens the window.',
  '- The first sentence becomes the title.',
  '',
  '## Open questions',
  '',
  '- How many parts?',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] Hotkey raises Drey',
  '- [x] Escape closes it',
  '',
  '## Plan',
  '',
  '### Parts',
  '',
  '- one',
].join('\n');

describe('shapeFaceOf', () => {
  const face = shapeFaceOf(BODY);

  it('keeps the known chapters as rows, in order', () => {
    expect(face.sections.map((s) => s.title)).toEqual(['Goal', 'Decisions', 'Open questions', 'Acceptance criteria']);
  });

  it('joins a paragraph and a wrapped bullet', () => {
    expect(face.sections[0]!.paragraphs).toEqual(['Press one hotkey, speak, and get a ticket.']);
    expect(face.sections[1]!.items.map((i) => i.text)).toEqual(['Win+H is the engine; Drey only opens the window.', 'The first sentence becomes the title.']);
    expect(face.sections[1]!.items[0]!.checked).toBeNull();
  });

  it('reads checkboxes', () => {
    expect(face.sections[3]!.items).toEqual([
      { text: 'Hotkey raises Drey', checked: false },
      { text: 'Escape closes it', checked: true },
    ]);
  });

  it('leaves the other chapters as Markdown', () => {
    expect(face.rest).toContain('## Plan');
    expect(face.rest).toContain('- one');
    expect(face.rest).not.toContain('Goal');
  });

  it('drops a heading left with nothing', () => {
    expect(shapeFaceOf('## Plan\n\n## Goal\n\nx').rest).toBe('');
  });
});

describe('editorOf', () => {
  const marks = [
    { text: 'Win+H is the engine', by: 'model' as const },
    { text: 'The first sentence becomes the title.', by: 'you' as const },
  ];
  it('matches on the line text', () => {
    expect(editorOf('Win+H is the engine; Drey only opens the window.', marks)).toBe('model');
    expect(editorOf('The first sentence becomes the title.', marks)).toBe('you');
    expect(editorOf('Nothing leaves the machine.', marks)).toBeNull();
    expect(editorOf('', marks)).toBeNull();
  });
});

describe('formOf', () => {
  it('reads scout, defaults to ship', () => {
    expect(formOf('---\nid: T-1\nform: scout\n---\n\nx')).toBe('scout');
    expect(formOf('---\nid: T-1\nform: ship\n---\n')).toBe('ship');
    expect(formOf('---\nid: T-1\n---\n')).toBe('ship');
    expect(formOf('no frontmatter')).toBe('ship');
  });
});
