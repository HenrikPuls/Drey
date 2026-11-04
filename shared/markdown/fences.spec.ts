import { describe, expect, it } from 'vitest';
import { fencedLineFlags, maskFenceLines, maskFences } from './fences';

const trimmed = (text: string): string[] => maskFences(text).split('\n').map((line) => line.trim());

describe('maskFences', () => {
  it('keeps length and newlines, blanks the fence with its delimiters', () => {
    const text = 'a\n```mermaid\n## Plan\n- [ ] x\n```\nb\n';
    expect(maskFences(text)).toHaveLength(text.length);
    expect(trimmed(text)).toEqual(['a', '', '', '', '', 'b', '']);
  });

  it('handles tilde fences and longer closing fences', () => {
    expect(trimmed('~~~\n## X\n~~~\n## Y')).toEqual(['', '', '', '## Y']);
    expect(trimmed('```\n## X\n`````\n## Y')).toEqual(['', '', '', '## Y']);
  });

  it('does not close a long fence with a shorter one (nested fence lengths)', () => {
    expect(trimmed('````md\n```mermaid\n## inner\n```\n## still inside\n````\n## out')).toEqual([
      '', '', '', '', '', '', '## out',
    ]);
  });

  it('does not close a fence with another character or a line that has an info string', () => {
    expect(trimmed('```\n~~~\n```js\n## inside\n```\n## out')).toEqual(['', '', '', '', '', '## out']);
  });

  it('opens an indented fence and a fence in a list item or quote', () => {
    expect(trimmed('- item\n  ```mermaid\n  ## in list\n  ```\n> ```\n> ## quoted\n> ```\n## out')).toEqual([
      '- item', '', '', '', '', '', '', '## out',
    ]);
    expect(trimmed('- ```mermaid\n  ## x\n  ```\n## out')).toEqual(['', '', '', '## out']);
  });

  it('treats a line with inline triple backticks as no fence', () => {
    expect(maskFences('```x``` and\n## Real')).toBe('```x``` and\n## Real');
  });

  it('ends an unterminated fence at the next column-0 level-2 heading', () => {
    const lines = maskFences('## Plan\n```mermaid\ngraph TD\n- [ ] x\n## Verification\n- [x] `a`\n').split('\n');
    expect(lines[1]!.trim()).toBe('');
    expect(lines[3]!.trim()).toBe('');
    expect(lines[4]).toBe('## Verification');
    expect(lines[5]).toBe('- [x] `a`');
  });

  it('runs an unterminated fence with no later heading to the end', () => {
    expect(trimmed('a\n```\nb\nc')).toEqual(['a', '', '', '']);
  });

  it('keeps CR in CRLF text and recognises CRLF delimiters', () => {
    const text = 'a\r\n```mermaid\r\n## x\r\n```\r\n## out\r\n';
    expect(maskFences(text)).toBe(`a\r\n${' '.repeat(10)}\r\n${' '.repeat(4)}\r\n${' '.repeat(3)}\r\n## out\r\n`);
  });

  it('returns text without any fence as is', () => {
    const text = '## Plan\n- [ ] a\n';
    expect(maskFences(text)).toBe(text);
  });
});

describe('fencedLineFlags / maskFenceLines', () => {
  it('flags the lines of each fence', () => {
    expect(fencedLineFlags(['a', '```', 'b', '```', 'c'])).toEqual([false, true, true, true, false]);
  });

  it('blanks lines in place', () => {
    expect(maskFenceLines(['a', '```', '## b', '```'])).toEqual(['a', '   ', '    ', '   ']);
  });
});
