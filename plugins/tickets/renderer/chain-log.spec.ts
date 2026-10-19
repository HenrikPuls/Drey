import { describe, expect, it } from 'vitest';
import { asParagraphs, chainLogStamp, visibleChainLog } from './chain-log';

const A = '[fleet 2026-10-18T10:00:00.000Z] one';
const B = '[fleet 2026-10-18T10:00:05.000Z] two\ncontinued';
const C = '[fleet 2026-10-18T10:00:09.000Z] three';

describe('visibleChainLog', () => {
  it('shows everything before a clear', () => {
    expect(visibleChainLog(`${A}\n${B}`, '')).toBe(`${A}\n${B}`);
  });

  it('hides lines up to the cleared stamp and keeps newer ones, continuations included', () => {
    expect(visibleChainLog(`${A}\n${B}\n${C}`, chainLogStamp(A))).toBe(`${B}\n${C}`);
  });

  it('is empty right after a clear', () => {
    expect(visibleChainLog(`${A}\n${B}`, '2026-10-18T10:00:05.000Z')).toBe('');
  });
});

describe('asParagraphs', () => {
  it('makes one paragraph per non-empty line and leaves a normal log line untouched', () => {
    const line = '[fleet 2026-10-18T22:22:53.983Z] daemon pid 35160 starting in C:\\Users\\puls (v1)';
    expect(asParagraphs(`${line}\n\n  second line  \n`)).toBe(`${line}\n\nsecond line`);
  });

  it('escapes only what would change the meaning of a line', () => {
    expect(asParagraphs('# not a heading')).toBe('\\# not a heading');
    expect(asParagraphs('- not a list')).toBe('\\- not a list');
    expect(asParagraphs('3. not a list')).toBe('\\3. not a list');
    expect(asParagraphs('a *b* <c> `d`')).toBe('a \\*b\\* \\<c> \\`d\\`');
  });

  it('is empty for no text', () => {
    expect(asParagraphs('')).toBe('');
  });
});
