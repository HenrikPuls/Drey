import { describe, expect, it } from 'vitest';
import { appendStatusLine, isStatusVerb, openDecisions, parseStatusLog } from './status-log';

const NOW = new Date('2026-11-01T14:30:00.000Z');

describe('parseStatusLog', () => {
  it('parses the machine grammar, oldest first', () => {
    const text = [
      '- 2026-11-01T14:30:00Z working: plan draft ready',
      '- 2026-11-01T14:31:12Z needs-decision: [key=base-ref] fork from the freshest ref?',
      '- 2026-11-01T15:02:40Z paused: waiting for CI until 16:00',
    ].join('\n');

    expect(parseStatusLog(text)).toEqual([
      { ts: '2026-11-01T14:30:00Z', verb: 'working', key: null, detail: 'plan draft ready' },
      { ts: '2026-11-01T14:31:12Z', verb: 'needs-decision', key: 'base-ref', detail: 'fork from the freshest ref?' },
      { ts: '2026-11-01T15:02:40Z', verb: 'paused', key: null, detail: 'waiting for CI until 16:00' },
    ]);
  });

  it('skips human scribbles and empty lines without failing', () => {
    const text = 'random note\n\n- not-a-verb: x\n- 2026-11-01T14:30:00Z working: ok\n';

    expect(parseStatusLog(text)).toEqual([
      { ts: '2026-11-01T14:30:00Z', verb: 'working', key: null, detail: 'ok' },
    ]);
  });

  it('reads a keyless needs-decision as key null (nothing to fold)', () => {
    const entries = parseStatusLog('- 2026-11-01T14:30:00Z needs-decision: what now?');

    expect(entries[0]!.key).toBeNull();
    expect(openDecisions(entries)).toEqual([]);
  });
});

describe('appendStatusLine', () => {
  it('appends after existing content, stamping seconds-free UTC', () => {
    const text = appendStatusLine('', NOW, 'working', 'starting');

    expect(text).toBe('- 2026-11-01T14:30:00Z working: starting');
    expect(appendStatusLine(text, new Date('2026-11-01T14:31:12.345Z'), 'done', '')).toBe(
      '- 2026-11-01T14:30:00Z working: starting\n- 2026-11-01T14:31:12Z done: ',
    );
  });

  it('writes the key marker for keyed verbs and refuses malformed keys', () => {
    const text = appendStatusLine('', NOW, 'blocked', 'CI red', 'ci-red');

    expect(text).toBe('- 2026-11-01T14:30:00Z blocked: [key=ci-red] CI red');
    expect(() => appendStatusLine('', NOW, 'blocked', 'x', 'Bad Key!')).toThrow('status-log key');
    // resolved carries the key positionally, not as a marker.
    expect(appendStatusLine('', NOW, 'resolved', 'ci-red')).toBe('- 2026-11-01T14:30:00Z resolved: ci-red');
  });

  it('ignores a key on non-keyed verbs', () => {
    expect(appendStatusLine('', NOW, 'done', 'shipped', 'ignored')).toBe('- 2026-11-01T14:30:00Z done: shipped');
  });
});

describe('openDecisions', () => {
  it('keeps an open key visible under newer unrelated lines until resolved', () => {
    const entries = parseStatusLog(
      [
        '- 2026-11-01T14:31:12Z needs-decision: [key=base-ref] fork from the freshest ref?',
        '- 2026-11-01T14:40:00Z working: researching',
        '- 2026-11-01T14:50:00Z done: plan written',
      ].join('\n'),
    );

    expect(openDecisions(entries)).toEqual([
      { key: 'base-ref', verb: 'needs-decision', ts: '2026-11-01T14:31:12Z', detail: 'fork from the freshest ref?' },
    ]);
  });

  it('closes on resolved, and a newer keyed line reopens with the newest wording', () => {
    const entries = parseStatusLog(
      [
        '- 2026-11-01T14:31:12Z blocked: [key=ci-red] the gate failed',
        '- 2026-11-01T15:00:00Z resolved: ci-red',
        '- 2026-11-01T15:10:00Z needs-decision: [key=ci-red] retry now or wait?',
      ].join('\n'),
    );

    expect(openDecisions(entries)).toEqual([
      { key: 'ci-red', verb: 'needs-decision', ts: '2026-11-01T15:10:00Z', detail: 'retry now or wait?' },
    ]);
  });

  it('round-trips through append + parse', () => {
    let text = '';
    text = appendStatusLine(text, NOW, 'needs-decision', 'which repo?', 'repo-pick');
    text = appendStatusLine(text, new Date('2026-11-01T14:35:00Z'), 'resolved', 'repo-pick');

    expect(openDecisions(parseStatusLog(text))).toEqual([]);
  });
});

describe('isStatusVerb', () => {
  it('knows the grammar', () => {
    expect(isStatusVerb('paused')).toBe(true);
    expect(isStatusVerb('thinking')).toBe(false);
  });
});
