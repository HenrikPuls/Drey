/**
 * The safe Markdown reader's specs (E5c): every block kind, the checkbox
 * flag, tolerance of broken input — and the one iron rule: HTML in the
 * source stays text in the output model, never markup.
 */
import { renderMarkdown } from './markdown';

function kinds(text: string): string[] {
  return renderMarkdown(text).map((block) => block.kind);
}

describe('renderMarkdown', () => {
  it('parses nothing into no blocks', () => {
    expect(renderMarkdown('')).toEqual([]);
    expect(renderMarkdown('  \n\n ')).toEqual([]);
  });

  it('parses headings with their level and trimmed text', () => {
    expect(renderMarkdown('# One')).toEqual([{ kind: 'heading', level: 1, text: 'One' }]);
    expect(renderMarkdown('## Description ##')).toEqual([{ kind: 'heading', level: 2, text: 'Description' }]);
    expect(renderMarkdown('###   Acceptance criteria  ')).toEqual([
      { kind: 'heading', level: 3, text: 'Acceptance criteria' },
    ]);
    expect(renderMarkdown('###### deep')).toEqual([{ kind: 'heading', level: 6, text: 'deep' }]);
  });

  it('joins a paragraph’s lines with spaces', () => {
    expect(renderMarkdown('What and why,\nin plain Markdown.\nLinks to PRs.')).toEqual([
      { kind: 'paragraph', text: 'What and why, in plain Markdown. Links to PRs.' },
    ]);
  });

  it('keeps separate paragraphs apart', () => {
    expect(kinds('first\n\nsecond')).toEqual(['paragraph', 'paragraph']);
  });

  it('merges adjacent bullet items into one list block', () => {
    expect(renderMarkdown('- one\n- two\n* three\n+ four')).toEqual([
      {
        kind: 'list',
        items: [
          { text: 'one', checked: null },
          { text: 'two', checked: null },
          { text: 'three', checked: null },
          { text: 'four', checked: null },
        ],
      },
    ]);
  });

  it('flags checkbox items checked and unchecked', () => {
    expect(renderMarkdown('- [x] `npm run build`\n- [ ] `npm test`\n- [X] upper')).toEqual([
      {
        kind: 'list',
        items: [
          { text: '`npm run build`', checked: true },
          { text: '`npm test`', checked: false },
          { text: 'upper', checked: true },
        ],
      },
    ]);
  });

  it('reads a bare checkbox marker as an empty item', () => {
    expect(renderMarkdown('- [x]')).toEqual([{ kind: 'list', items: [{ text: '', checked: true }] }]);
  });

  it('ends a list at a blank line or an interleaved paragraph', () => {
    expect(kinds('- one\n- two\n\n- later')).toEqual(['list', 'list']);
    expect(kinds('- one\na note\n- two')).toEqual(['list', 'paragraph', 'list']);
  });

  it('collects fenced code with its newlines', () => {
    expect(renderMarkdown('```json\n{"a": 1}\n```')).toEqual([{ kind: 'code', text: '{"a": 1}' }]);
    expect(renderMarkdown('before\n```\nlet x = 1;\nlet y = 2;\n```\nafter')).toEqual([
      { kind: 'paragraph', text: 'before' },
      { kind: 'code', text: 'let x = 1;\nlet y = 2;' },
      { kind: 'paragraph', text: 'after' },
    ]);
  });

  it('closes an unterminated fence at the end of the text', () => {
    expect(renderMarkdown('```\nnever closed\nstill code')).toEqual([
      { kind: 'code', text: 'never closed\nstill code' },
    ]);
  });

  it('normalizes CRLF line endings', () => {
    expect(renderMarkdown('## Plan\r\n\r\n- [ ] step')).toEqual([
      { kind: 'heading', level: 2, text: 'Plan' },
      { kind: 'list', items: [{ text: 'step', checked: false }] },
    ]);
  });

  it('never emits HTML: markup in the source stays data a template escapes', () => {
    const blocks = renderMarkdown('hello <b>bold</b> <script>alert(1)</script>');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'hello <b>bold</b> <script>alert(1)</script>' }]);
  });

  it('drops what is not a block (setext rules, tables) into paragraphs', () => {
    expect(renderMarkdown('a table row\n| a | b |\n| - | - |')).toEqual([
      { kind: 'paragraph', text: 'a table row | a | b | | - | - |' },
    ]);
    expect(renderMarkdown('---')).toEqual([{ kind: 'paragraph', text: '---' }]);
  });

  it('treats heading and list markers without a space as plain text', () => {
    expect(renderMarkdown('#NoSpace')).toEqual([{ kind: 'paragraph', text: '#NoSpace' }]);
    expect(renderMarkdown('-NoSpace')).toEqual([{ kind: 'paragraph', text: '-NoSpace' }]);
  });
});
