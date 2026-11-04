import { describe, expect, it } from 'vitest';

import { flatInt, flatList, flatText, parseFlatDocument } from './flat-frontmatter';

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
