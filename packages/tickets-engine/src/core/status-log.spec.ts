import { describe, expect, it } from 'vitest';
import { appendStatusLine, openStatusItems, parseStatusLog } from './status-log';

describe('parseStatusLog', () => {
  it('reads the strict verb grammar and forgives the rest', () => {
    const lines = parseStatusLog(
      [
        `- '2026-11-02T09:00:00Z' working: build on opus`,
        `- '2026-11-02T09:12:00Z' needs-decision: [palette-shortcut] Which shortcut should open the palette?`,
        `- '2026-11-02T09:30:00Z' blocked: [ci] waiting for the build`,
        `not a status line`,
        `- '2026-11-02T09:40:00Z' resolved: palette-shortcut`,
        `- '2026-11-02T09:45:00Z' done: handed over`,
      ].join('\n'),
    );
    expect(lines).toHaveLength(5);
    expect(lines[1]).toEqual({
      at: '2026-11-02T09:12:00Z',
      verb: 'needs-decision',
      key: 'palette-shortcut',
      text: 'Which shortcut should open the palette?',
    });
    expect(lines[3]).toEqual({ at: '2026-11-02T09:40:00Z', verb: 'resolved', key: 'palette-shortcut', text: '' });
  });
});

describe('openStatusItems — the open-decisions fold', () => {
  it('keeps open keys visible across newer lines until resolved', () => {
    const lines = parseStatusLog(
      [
        `- '1' needs-decision: [a] first question`,
        `- '2' working: build`,
        `- '3' needs-decision: [b] second question`,
        `- '4' blocked: [ci] waiting`,
        `- '5' resolved: a`,
      ].join('\n'),
    );
    expect(openStatusItems(lines)).toEqual([
      { verb: 'needs-decision', key: 'b', text: 'second question', since: '3' },
      { verb: 'blocked', key: 'ci', text: 'waiting', since: '4' },
    ]);
  });

  it('a keyless line surfaces as its own item instead of vanishing', () => {
    const lines = parseStatusLog(`- '1' blocked: something opaque\n`);
    expect(openStatusItems(lines)).toEqual([{ verb: 'blocked', key: null, text: 'something opaque', since: '1' }]);
  });
});

describe('appendStatusLine', () => {
  it('starts an absent file and appends with one newline between lines', () => {
    const first = appendStatusLine('', '1', 'working', ' build');
    expect(first).toBe(`- '1' working: build\n`);
    expect(appendStatusLine(first, '2', 'done', 'handed over')).toBe(
      `- '1' working: build\n- '2' done: handed over\n`,
    );
  });
});
