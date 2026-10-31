import { describe, expect, it } from 'vitest';
import { parseChanges, storyOf } from './changes';

const TICKET = (changes: string): string => `---
id: T-0126
title: 'Palette opens twice on slow CI'
---
## Description

What and why.

## Plan

How.

## Changes
${changes}
## Log

- '2026-10-31T05:24:08Z' owner@legion — created in inbox
`;

describe('parseChanges', () => {
  it('reads the canonical section', () => {
    const parsed = parseChanges(
      TICKET(`
**What changed for you:** The command palette opens once, even when Ctrl+P is pressed twice quickly.
Nothing else you can see has changed.

**Where:**
- M \`src/app/palette/palette.service.ts\` — a second open while one is opening is ignored
- A \`src/app/palette/palette.service.spec.ts\` — two new tests for the double press

**Checks:**
- 412 tests passed, lint, the four typechecks, import cycles
- rebased on main 2 min ago, no conflicts

**How to try it:** 1. Launch this version · 2. Press Ctrl+P twice, fast · 3. One palette opens
`),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.forYou).toBe(
      'The command palette opens once, even when Ctrl+P is pressed twice quickly.\nNothing else you can see has changed.',
    );
    expect(parsed!.files).toEqual([
      { status: 'M', path: 'src/app/palette/palette.service.ts', why: 'a second open while one is opening is ignored' },
      { status: 'A', path: 'src/app/palette/palette.service.spec.ts', why: 'two new tests for the double press' },
    ]);
    expect(parsed!.checks).toEqual([
      '412 tests passed, lint, the four typechecks, import cycles',
      'rebased on main 2 min ago, no conflicts',
    ]);
    expect(parsed!.howToTry).toBe('1. Launch this version · 2. Press Ctrl+P twice, fast · 3. One palette opens');
  });

  it('is null without the section, and stops at the next H2', () => {
    expect(parseChanges('---\nid: T-0001\n---\n## Description\n\nnothing\n')).toBeNull();
    const withLog = `## Changes

**How to try it:** 1. Launch

## Log

- '2026-10-31T05:24:08Z' owner@legion — created in inbox
`;
    const parsed = parseChanges(withLog);
    expect(parsed!.howToTry).toBe('1. Launch');
    expect(parsed!.forYou).toBeNull();
    expect(parsed!.files).toEqual([]);
    expect(parsed!.checks).toEqual([]);
  });

  it('tolerates case-free labels, * bullets, missing parts and unbackticked paths', () => {
    const parsed = parseChanges(
      TICKET(`
**what changed for you** the one line
**where**
* m src/app/x.ts - a hyphen and no ticks
- D \`gone.ts\`
**CHECKS:**
* checks green
`),
    );
    expect(parsed!.forYou).toBe('the one line');
    expect(parsed!.files).toEqual([
      { status: 'M', path: 'src/app/x.ts', why: 'a hyphen and no ticks' },
      { status: 'D', path: 'gone.ts', why: '' },
    ]);
    expect(parsed!.checks).toEqual(['checks green']);
    expect(parsed!.howToTry).toBeNull();
  });

  it('never throws on garbage', () => {
    const parsed = parseChanges('## Changes\n\n**Where:**\n- total nonsense\n- also `unclosed');
    expect(parsed!.files).toEqual([]);
  });
});

describe('storyOf', () => {
  const STORY = `## Log

- '2026-10-31T09:02:00Z' owner@legion — created in inbox
- '2026-10-31T09:02:20Z' owner@legion — inbox -> prioritized
- '2026-10-31T09:05:00Z' agent@legion — run R-1 started (opencode, zai-coding-plan/glm-5.3-flash) — worktree created, handover fresh
- '2026-10-31T09:05:30Z' agent@legion — run R-1 done — gate green, moving to plan-review
- '2026-10-31T09:07:00Z' owner@legion — plan-review -> build
- '2026-10-31T09:08:00Z' agent@legion — run R-2 started (opencode)
- '2026-10-31T09:16:00Z' agent@legion — run R-2 done — gate green, moving to review
- '2026-10-31T09:16:10Z' agent@legion — run done — 40k in (12k cached) / 3.5k out
- '2026-10-31T09:17:00Z' owner@legion — review -> done
`;

  it('maps the Log beats to story items with the UTC clock', () => {
    const { items } = storyOf(STORY);
    expect(items).toEqual([
      { at: '09:02', what: 'Captured', who: 'you' },
      { at: '09:02', what: '-> prioritized', who: 'you' },
      { at: '09:05', what: '-> plan-review', who: 'opencode · glm-5.3-flash' },
      { at: '09:07', what: 'Building', who: 'you' },
      { at: '09:16', what: 'Built and tested', who: 'opencode' },
      { at: '09:17', what: 'Ready to try', who: 'you' },
    ]);
  });

  it('totals minutes from first to last stamp and tokens from the usage lines', () => {
    const { totals } = storyOf(STORY);
    expect(totals.minutes).toBe(15);
    expect(totals.tokens).toBe(40_000 + 3_500);
  });

  it('names the beats of a sent-back and an accepted ticket', () => {
    const { items } = storyOf(
      [
        "- '2026-10-31T09:00:00Z' owner@legion — created in inbox",
        "- '2026-10-31T09:30:00Z' owner@legion — build -> done",
        "- '2026-10-31T09:31:00Z' owner@legion — done -> build",
        "- '2026-10-31T09:31:10Z' owner@legion — sent back: the palette still doubled",
        "- '2026-10-31T09:40:00Z' owner@legion — archived",
      ].join('\n'),
    );
    expect(items.map((i) => i.what)).toEqual([
      'Captured',
      'Ready to try',
      'Building',
      'Sent back',
      'Accepted',
    ]);
    expect(storyOf("## Log\n\n- '2026-10-31T09:40:00Z' owner@legion — archived").totals.minutes).toBe(0);
  });

  it('reads null totals when nothing reports, and skips human lines', () => {
    const story = storyOf("## Log\n\nlooked at it again today");
    expect(story.items).toEqual([]);
    expect(story.totals).toEqual({ minutes: null, tokens: null });
  });
});
