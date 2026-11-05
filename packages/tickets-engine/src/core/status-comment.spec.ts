import { describe, expect, it } from 'vitest';
import { openStatusItems } from './status-log';
import { parseStatusComment, renderStatusComment, slugStatusKey, statusLinesOfComments } from './status-comment';

describe('status comments', () => {
  it('does not persist working', () => {
    expect(renderStatusComment({ verb: 'working', text: 'build on opus' })).toBeNull();
  });

  it('renders a keyed decision, a blocker, a plain verb and a resolve with detail', () => {
    expect(renderStatusComment({ verb: 'needs-decision', key: 'Palette-Shortcut', text: 'Which\nshortcut?' })).toBe(
      'needs-decision: [palette-shortcut] Which shortcut?',
    );
    expect(renderStatusComment({ verb: 'blocked', text: 'waiting for CI' })).toBe('blocked: waiting for CI');
    expect(renderStatusComment({ verb: 'failed', text: 'gate red' })).toBe('failed: gate red');
    expect(renderStatusComment({ verb: 'resolved', key: 'palette-shortcut', detail: 'Ctrl+K.' })).toBe(
      'resolved: palette-shortcut\n\nCtrl+K.',
    );
  });

  it('refuses a keyless resolve (it would close nothing)', () => {
    expect(renderStatusComment({ verb: 'resolved', key: 'not a key!' })).toBeNull();
  });

  it('round-trips through the status-log grammar and ignores ordinary comments', () => {
    const lines = statusLinesOfComments([
      { at: '2026-11-05T09:00:00Z', text: 'needs-decision: [k1] Which one?' },
      { at: '2026-11-05T09:01:00Z', text: 'looks good to me' },
      { at: '2026-11-05T09:02:00Z', text: 'blocked: [ci] waiting for CI\n\nrun 7 stalled' },
      { at: '2026-11-05T09:03:00Z', text: 'resolved: k1\n\nthe first one' },
    ]);
    expect(lines.map((l) => [l.verb, l.key, l.text])).toEqual([
      ['needs-decision', 'k1', 'Which one?'],
      ['blocked', 'ci', 'waiting for CI'],
      ['resolved', 'k1', ''],
    ]);
    expect(openStatusItems(lines).map((i) => i.key)).toEqual(['ci']);
  });

  it('folds a resolve that shares its second with its decision after it, whatever the file order', () => {
    // dk names comment files <second>-<author>: same second, author-name order — here the resolver sorts first.
    const lines = statusLinesOfComments([
      { at: '2026-11-05T09:00:00Z', text: 'resolved: k1\n\nCtrl+K' },
      { at: '2026-11-05T09:00:00Z', text: 'needs-decision: [k1] Which one?' },
      { at: '2026-11-05T08:59:59Z', text: 'blocked: [ci] earlier' },
    ]);
    expect(lines.map((l) => l.verb)).toEqual(['blocked', 'needs-decision', 'resolved']);
    expect(openStatusItems(lines).map((i) => i.key)).toEqual(['ci']);
  });

  it('parses nothing from a comment with a hostile timestamp', () => {
    expect(parseStatusComment("x' blocked: y", 'done: z')).toBeNull();
  });

  it('slugs a title into a key', () => {
    expect(slugStatusKey('Which shortcut should open the palette?')).toBe('which-shortcut-should-open-the-palette');
    expect(slugStatusKey('???')).toBeNull();
  });
});
