import { describe, expect, it } from 'vitest';
import { appendVerlaufEntry, parseVerlaufEntries, renderVerlaufLine, verlaufEntryOf, VERLAUF_HEADING } from './verlauf';

const TICKET = `---
id: T-0001
title: Add the thing
---

It should work.

## Plan

Step by step.

## Log

- '2026-11-02T09:00:00Z' owner@box — created
`;

describe('verlaufEntryOf — the settled run becomes one entry', () => {
  it('maps the outcome and formats tokens, cost and duration like the concept shows', () => {
    expect(
      verlaufEntryOf({
        phase: 'plan',
        persona: 'pia',
        model: 'opus',
        tokensIn: 48_000,
        tokensOut: 6_000,
        cost: 1.17,
        startedAt: '2026-11-02T09:00:00Z',
        endedAt: '2026-11-02T09:12:00Z',
        state: 'done',
      }),
    ).toEqual({
      phase: 'plan',
      persona: 'pia',
      model: 'opus',
      tokens: '54k',
      cost: 1.17,
      dauer: '12m',
      ausgang: 'handed-over',
    });
  });

  it('maps failed and stopped runs; a sub-minute run is 0m; unknown cost stays null', () => {
    const base = {
      phase: 'build',
      persona: null,
      model: null,
      tokensIn: 3_400_000,
      tokensOut: 800,
      cost: null,
      startedAt: '2026-11-02T09:00:00Z',
      endedAt: '2026-11-02T09:00:30Z',
    };
    expect(verlaufEntryOf({ ...base, state: 'failed' }).ausgang).toBe('failed');
    expect(verlaufEntryOf({ ...base, state: 'stopped' }).ausgang).toBe('stopped');
    expect(verlaufEntryOf({ ...base, state: 'done' }).dauer).toBe('0m');
    expect(verlaufEntryOf({ ...base, state: 'done' }).tokens).toBe('3.4M');
  });
});

describe('renderVerlaufLine / parseVerlaufEntries — one line per run, newest at the bottom', () => {
  it('renders the seven-key inline map the concept specifies', () => {
    expect(
      renderVerlaufLine({
        phase: 'plan',
        persona: 'pia',
        model: 'opus',
        tokens: '48k',
        cost: 0.24,
        dauer: '12m',
        ausgang: 'handed-over',
      }),
    ).toBe('- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 0.24, dauer: 12m, ausgang: handed-over }');
    expect(
      renderVerlaufLine({
        phase: 'build',
        persona: null,
        model: 'glm-5.3',
        tokens: '121k',
        cost: 0.427,
        dauer: '41m',
        ausgang: 'failed',
      }),
    ).toBe('- { phase: build, persona: null, model: glm-5.3, tokens: 121k, cost: 0.427, dauer: 41m, ausgang: failed }');
  });

  it('appends into the existing chapter, keeping the earlier entries', () => {
    const once = appendVerlaufEntry(TICKET, renderVerlaufLine({ phase: 'plan', persona: 'pia', model: 'opus', tokens: '48k', cost: 0.24, dauer: '12m', ausgang: 'handed-over' }));
    const twice = appendVerlaufEntry(once, renderVerlaufLine({ phase: 'build', persona: 'ben', model: 'glm-5.3', tokens: '121k', cost: 0.61, dauer: '41m', ausgang: 'handed-over' }));
    expect(parseVerlaufEntries(twice)).toHaveLength(2);
    expect(parseVerlaufEntries(twice)[0]).toMatchObject({ phase: 'plan', cost: 0.24 });
    expect(parseVerlaufEntries(twice)[1]).toMatchObject({ phase: 'build', ausgang: 'handed-over' });
    // The rest of the file survives untouched.
    expect(twice).toContain('## Log\n\n- \'2026-11-02T09:00:00Z\' owner@box — created');
    expect(twice.indexOf('## Log')).toBeGreaterThan(twice.indexOf(VERLAUF_HEADING));
  });

  it('creates the chapter before ## Log when absent; at the end when there is none', () => {
    const withLog = appendVerlaufEntry(TICKET, '- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 0.24, dauer: 12m, ausgang: handed-over }');
    expect(withLog).toContain('## Verlauf\n\n- { phase: plan');
    expect(withLog.indexOf('## Verlauf')).toBeLessThan(withLog.indexOf('## Log'));

    const withoutLog = appendVerlaufEntry(
      TICKET.slice(0, TICKET.indexOf('## Log')).trimEnd(),
      '- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 0.24, dauer: 12m, ausgang: handed-over }',
    );
    expect(withoutLog.endsWith('\n## Verlauf\n\n- { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 0.24, dauer: 12m, ausgang: handed-over }\n')).toBe(true);
  });

  it('reads tolerantly: absent chapter, torn lines and null fields degrade', () => {
    expect(parseVerlaufEntries('no chapter here')).toEqual([]);
    const text = appendVerlaufEntry(TICKET, '- { phase: build, persona: null, model: glm-5.3, tokens: 121k, cost: null, dauer: 41m, ausgang: failed }');
    expect(parseVerlaufEntries(text)).toEqual([
      { phase: 'build', persona: null, model: 'glm-5.3', tokens: '121k', cost: null, dauer: '41m', ausgang: 'failed' },
    ]);
    const torn = appendVerlaufEntry(TICKET, '- { phase build, broken');
    expect(parseVerlaufEntries(torn)).toEqual([]);
  });
});
