import { describe, expect, it } from 'vitest';
import { qrMatrix } from './qr';

/**
 * req-66: the pairing QR encoder. Decoding was verified against OpenCV
 * for versions 1–10 when it was written; these specs pin the structure.
 */

function finderAt(m: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y0 + dy]![x0 + dx] !== (ring !== 2)) {
        return false;
      }
    }
  }
  return true;
}

describe('qrMatrix', () => {
  it('picks the smallest version that fits (17 + 4 × version modules)', () => {
    expect(qrMatrix('A').length).toBe(21);
    expect(qrMatrix('https://desk.tail3e1f.ts.net/#pair=K7Q4MZP2XA').length).toBe(33);
    expect(qrMatrix('x'.repeat(213)).length).toBe(57);
  });

  it('draws the three finder patterns, the timing lines and the dark module', () => {
    const m = qrMatrix('https://desk.example/#pair=ABCDE12345');
    const n = m.length;
    expect(finderAt(m, 0, 0)).toBe(true);
    expect(finderAt(m, n - 7, 0)).toBe(true);
    expect(finderAt(m, 0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true);
  });

  it('is deterministic and square', () => {
    const a = qrMatrix('same text');
    expect(qrMatrix('same text')).toEqual(a);
    expect(a.every((row) => row.length === a.length)).toBe(true);
  });

  it('refuses text beyond version 10-M', () => {
    expect(() => qrMatrix('x'.repeat(214))).toThrow(/too long/);
  });
});
