import { describe, expect, it } from 'vitest';
import { parseReplyInline, splitRow } from './markdown';

describe('parseReplyInline', () => {
  it('splits code, bold and italic, leaving snake_case words alone', () => {
    expect(parseReplyInline('a `x` **b** *c* _d_ my_var_name')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'd' },
      { kind: 'text', text: ' my_var_name' },
    ]);
  });

  it('returns the whole line as one text span when nothing matches', () => {
    expect(parseReplyInline('plain line')).toEqual([{ kind: 'text', text: 'plain line' }]);
  });
});

describe('splitRow', () => {
  it('trims the outer pipes and every cell', () => {
    expect(splitRow(' | a | b *c* | ')).toEqual(['a', 'b *c*']);
  });

  it('keeps empty cells', () => {
    expect(splitRow('| a |  |')).toEqual(['a', '']);
  });
});
