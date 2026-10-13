import { extractDocumentFence } from './document-fence';

/**
 * Specs for the Ask reply's document-fence extraction (ADR-0053). The
 * Angular runner ignores `plugins/**`, so plugin specs live here.
 */

describe('extractDocumentFence', () => {
  it('extracts a four-backtick document fence with a lead-in sentence', () => {
    const reply = 'Sure — here it is:\n````document\n# Titel\nText\n````';
    expect(extractDocumentFence(reply)).toEqual({ document: '# Titel\nText\n' });
  });

  it('a three-backtick document fence still works (tolerance)', () => {
    const reply = '```document\nA\n```';
    expect(extractDocumentFence(reply)).toEqual({ document: 'A\n' });
  });

  it('inner ``` fences do not close a four-backtick block', () => {
    const reply = '````document\n# T\n```js\ncode();\n```\n# More\n````';
    expect(extractDocumentFence(reply)).toEqual({
      document: '# T\n```js\ncode();\n```\n# More\n',
    });
  });

  it('the longest document fence wins; ties go to the last', () => {
    const reply = [
      '````document',
      'short',
      '````',
      'Corrected:',
      '````document',
      'much longer body',
      '````',
    ].join('\n');
    expect(extractDocumentFence(reply)).toEqual({ document: 'much longer body\n' });

    const tie = '````document\none\n````\n````document\ntwo\n````';
    expect(extractDocumentFence(tie)).toEqual({ document: 'two\n' });
  });

  it('heals a single ```markdown-wrapped document with nothing else around it', () => {
    expect(extractDocumentFence('```markdown\n# Ganz\n```\n')).toEqual({ document: '# Ganz\n' });
    expect(extractDocumentFence('```\nNur ein Block\n```')).toEqual({
      document: 'Nur ein Block\n',
    });
  });

  it('the heal rejects prose or extra blocks outside the fence', () => {
    expect(extractDocumentFence('Vorher ein Satz:\n```\nA\n```')).toBeNull();
    expect(extractDocumentFence('```\nA\n```\nNachheld')).toBeNull();
    expect(extractDocumentFence('```\nA\n```\n```\nB\n```')).toBeNull();
  });

  it('returns null without any fence', () => {
    expect(extractDocumentFence('plain answer prose')).toBeNull();
    expect(extractDocumentFence('')).toBeNull();
  });

  it('normalizes CRLF', () => {
    expect(extractDocumentFence('````document\r\nA\r\nB\r\n````')).toEqual({
      document: 'A\nB\n',
    });
  });

  it('an unterminated document fence is not a document (falls to the heal, then null)', () => {
    expect(extractDocumentFence('````document\ntruncated…')).toBeNull();
  });
});
