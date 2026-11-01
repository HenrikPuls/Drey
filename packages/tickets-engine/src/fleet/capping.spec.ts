import { describe, expect, it } from 'vitest';
import { capHead, capTail, SANITY_CAP } from './capping';

/**
 * Output capping (T-0048): lines first, then bytes, never splitting a
 * code point; `truncated` only when something was actually removed.
 */

const lines = (n: number): string => [...Array(n).keys()].map((i) => `line ${i + 1}`).join('\n');

describe('capHead — keeps the head', () => {
  it('passes a text within both limits through untouched', () => {
    const capped = capHead('one\ntwo\nthree', { lines: 5, bytes: 100 });
    expect(capped).toEqual({ text: 'one\ntwo\nthree', truncated: false, originalSize: 13 });
  });

  it('cuts by lines first and keeps the first N lines', () => {
    const capped = capHead(lines(10), { lines: 3, bytes: 1000 });
    expect(capped.text).toBe('line 1\nline 2\nline 3');
    expect(capped.truncated).toBe(true);
    expect(capped.originalSize).toBe(Buffer.byteLength(lines(10), 'utf8'));
  });

  it('cuts by bytes on a char boundary when the lines fit', () => {
    const capped = capHead('a'.repeat(10), { lines: 5, bytes: 4 });
    expect(capped.text).toBe('aaaa');
    expect(capped.truncated).toBe(true);
  });

  it('never splits a multi-byte code point at the byte cut', () => {
    // 'ä' is 2 bytes: a 5-byte budget must keep two of them, not split the third.
    const text = 'ä'.repeat(6);
    const capped = capHead(text, { lines: 10, bytes: 5 });
    expect(capped.text).toBe('ää');
    expect(capped.truncated).toBe(true);
    // A surrogate pair (𝕏, 4 bytes) stays whole or is dropped entirely.
    const emoji = 'x𝕏x𝕏x';
    expect(capHead(emoji, { lines: 10, bytes: 6 }).text).toBe('x𝕏x');
    expect(capHead(emoji, { lines: 10, bytes: 5 }).text).toBe('x𝕏');
    expect(capHead(emoji, { lines: 10, bytes: 3 }).text).toBe('x');
  });

  it('counts a trailing newline as no extra line', () => {
    const capped = capHead(`${lines(3)}\n`, { lines: 3, bytes: 1000 });
    expect(capped.truncated).toBe(false);
    expect(capped.text).toBe(`${lines(3)}\n`);
  });

  it('the empty text caps to itself', () => {
    expect(capHead('', { lines: 3, bytes: 10 })).toEqual({ text: '', truncated: false, originalSize: 0 });
  });
});

describe('capTail — keeps the tail', () => {
  it('cuts by lines first and keeps the last N lines', () => {
    const capped = capTail(lines(10), { lines: 3, bytes: 1000 });
    expect(capped.text).toBe('line 8\nline 9\nline 10');
    expect(capped.truncated).toBe(true);
    expect(capped.originalSize).toBe(Buffer.byteLength(lines(10), 'utf8'));
  });

  it('cuts by bytes keeping the END when the lines fit', () => {
    const capped = capHead('abcdefghij', { lines: 5, bytes: 4 });
    expect(capped.text).toBe('abcd'); // the head keeps the front
    const tail = capTail('abcdefghij', { lines: 5, bytes: 4 });
    expect(tail.text).toBe('ghij'); // the tail keeps the end
    expect(tail.truncated).toBe(true);
    expect('abcdefghij'.endsWith(tail.text)).toBe(true);
  });

  it('keeps the last lines AND the last bytes together (a vitest-style tail)', () => {
    const text = [...Array(50).keys()].map((i) => `row ${i + 1}: ${'x'.repeat(20)}`).join('\n');
    const capped = capTail(text, { lines: 40, bytes: 200 });
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(200);
    // Whatever survived is the text's true suffix — the assertion summary.
    expect(text.endsWith(capped.text)).toBe(true);
    expect(capped.text).toContain('row 50');
  });

  it('never splits a multi-byte code point at the byte cut', () => {
    const text = `${'a'.repeat(3)}${'ä'.repeat(6)}`;
    const capped = capTail(text, { lines: 10, bytes: 5 });
    expect(capped.text).toBe('ää');
    expect(text.endsWith(capped.text)).toBe(true);
  });

  it('counts a trailing newline as no extra line', () => {
    const capped = capTail(`${lines(3)}\n`, { lines: 3, bytes: 1000 });
    expect(capped.truncated).toBe(false);
    expect(capped.text).toBe(`${lines(3)}\n`);
  });

  it('a text within the limits is untouched, whatever the direction', () => {
    const text = 'same text';
    expect(capTail(text, { lines: 2, bytes: 100 }).text).toBe(text);
    expect(capHead(text, { lines: 2, bytes: 100 }).text).toBe(text);
  });
});

describe('SANITY_CAP', () => {
  it('bounds a gate failure to a sane size', () => {
    const dump = `${lines(5_000)}\n`;
    const capped = capTail(dump, SANITY_CAP);
    expect(capped.truncated).toBe(true);
    // 400 visible lines plus the kept trailing newline.
    expect(capped.text.split('\n')).toHaveLength(SANITY_CAP.lines + 1);
    expect(capped.text.startsWith('line 4601\n')).toBe(true);
    expect(capped.text.endsWith('line 5000\n')).toBe(true);
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(SANITY_CAP.bytes);
    expect(dump.endsWith(capped.text)).toBe(true);
  });
});
