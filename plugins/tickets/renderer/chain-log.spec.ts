import { describe, expect, it } from 'vitest';
import { asCodeBlock, chainLogStamp, visibleChainLog } from './chain-log';

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

describe('asCodeBlock', () => {
  it('fences the text with three backticks', () => {
    expect(asCodeBlock('a\nb')).toBe('```text\na\nb\n```\n');
  });

  it('uses a longer fence than any backtick run in the text', () => {
    const block = asCodeBlock('x ``` y');
    expect(block.startsWith('````text\n')).toBe(true);
    expect(block.endsWith('\n````\n')).toBe(true);
  });
});
