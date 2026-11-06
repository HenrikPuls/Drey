import { describe, expect, it } from 'vitest';

import { flatInt, flatList, flatText, parseFlatDocument, withFlatField } from './flat-frontmatter';

describe('withFlatField', () => {
  const block = '---\nid: t-1\ntitle: Old: one\nowner: \n---';

  it('replaces one value and leaves every other byte', () => {
    expect(withFlatField(block, 'title', 'New: two')).toBe('---\nid: t-1\ntitle: New: two\nowner: \n---');
  });

  it('keeps a CRLF line ending', () => {
    expect(withFlatField('---\r\ntitle: a\r\n---', 'title', 'b')).toBe('---\r\ntitle: b\r\n---');
  });

  it('changes the duplicate the reader takes', () => {
    const next = withFlatField('---\ntitle: a\ntitle: b\n---', 'title', 'c');
    expect(next).toBe('---\ntitle: a\ntitle: c\n---');
    expect(parseFlatDocument(next).fields['title']).toBe('c');
  });

  it('does not read a longer key or the body as the field', () => {
    expect(() => withFlatField('---\ntitle-x: a\n---\ntitle: b\n', 'title', 'c')).toThrow(/no title/);
  });

  it('refuses a value that would add a line, and an unclosed block', () => {
    expect(() => withFlatField(block, 'title', 'a\nstage: done')).toThrow(/one line/);
    expect(() => withFlatField('---\ntitle: a\n', 'title', 'b')).toThrow(/not closed/);
    expect(() => withFlatField('title: a\n---', 'title', 'b')).toThrow(/not closed/);
  });
});

describe('flat front matter', () => {
  it('reads key: value lines and the body', () => {
    const doc = parseFlatDocument('---\nid: t-1\nstage: open\nowner: \nepoch: 3\n---\n\n## Description\n\nbody\n');
    expect(doc.fields).toEqual({ id: 't-1', stage: 'open', owner: '', epoch: '3' });
    expect(doc.body).toBe('\n## Description\n\nbody\n');
    expect(doc.issues).toEqual([]);
  });

  it('keeps colons in the value (valid flat, invalid YAML)', () => {
    const doc = parseFlatDocument('---\ntitle: a: b: c\nx-note: http://x/y\n---\n');
    expect(doc.fields['title']).toBe('a: b: c');
    expect(doc.fields['x-note']).toBe('http://x/y');
  });

  it('tolerates CRLF and a BOM', () => {
    const doc = parseFlatDocument('﻿---\r\nid: t-2\r\n---\r\nbody');
    expect(doc.fields).toEqual({ id: 't-2' });
    expect(doc.body).toBe('body');
  });

  it('reports malformed input instead of throwing', () => {
    expect(parseFlatDocument('no fence').issues).toEqual(['no front matter fence']);
    expect(parseFlatDocument('---\nid: t-1\n').issues).toContain('front matter is not closed');
    const odd = parseFlatDocument('---\nid: t-1\nnot a pair\nid: t-2\n---\n');
    expect(odd.issues).toEqual(['line 3 is not "key: value"', 'duplicate key id']);
    expect(odd.fields['id']).toBe('t-2');
  });

  it('has small typed accessors', () => {
    expect(flatList('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(flatList('')).toEqual([]);
    expect(flatList(undefined)).toEqual([]);
    expect(flatText('')).toBeNull();
    expect(flatText('x')).toBe('x');
    expect(flatInt('12')).toBe(12);
    expect(flatInt('')).toBeNull();
    expect(flatInt('1.5')).toBeNull();
  });
});
