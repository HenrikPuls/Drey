import { describe, expect, it } from 'vitest';
import {
  deletePlanPart,
  movePlanPart,
  parsePlanParts,
  partChainEntries,
  renderPlanParts,
  withPlanParts,
  type PlanPart,
} from './plan-parts';

const A: PlanPart = { title: 'Split a file diff into hunks', done: false, persona: 'ben', reason: 'pure logic first', chain: [] };
const B: PlanPart = {
  title: 'Hunk rows in the panel',
  done: true,
  persona: 'ben',
  reason: null,
  chain: ['insert security(ralf, notify) after review', 'skip qa'],
};
const C: PlanPart = { title: 'Changelog and manual', done: false, persona: null, reason: null, chain: [] };

const TICKET = `---
id: T-0130
title: "Git panel"
---

## Description

Stage single hunks.

## Plan

Do it in steps.

### Acceptance criteria

- [ ] \`npm test\`

## Log

- one
`;

describe('renderPlanParts / parsePlanParts', () => {
  it('writes the canonical chapter and reads it back', () => {
    const block = renderPlanParts([A, B, C]);
    expect(block).toBe(
      [
        '### Parts',
        '',
        '- [ ] Split a file diff into hunks',
        '  persona: ben',
        '  reason: pure logic first',
        '- [x] Hunk rows in the panel',
        '  persona: ben',
        '  chain: insert security(ralf, notify) after review; skip qa',
        '- [ ] Changelog and manual',
        '',
      ].join('\n'),
    );
    expect(parsePlanParts(`## Plan\n\n${block}`)).toEqual({ parts: [A, B, C], warnings: [] });
  });

  it('reads nothing without the chapter or without a Plan', () => {
    expect(parsePlanParts(TICKET)).toEqual({ parts: [], warnings: [] });
    expect(parsePlanParts('no sections')).toEqual({ parts: [], warnings: [] });
    // A Parts heading outside the Plan is not the plan's.
    expect(parsePlanParts('## Notes\n\n### Parts\n\n- [ ] x\n').parts).toEqual([]);
  });

  it('forgives: unreadable lines, unknown details, bad persona and chain entries warn and drop', () => {
    const text = [
      '## Plan',
      '',
      '### Parts',
      '',
      'stray prose',
      '- [ ] First',
      '  persona: Not A Persona',
      '  mood: cheerful',
      '  chain: skip qa; frobnicate everything',
      '- [ ] Second',
      '  reason:',
      '',
    ].join('\n');
    const parsed = parsePlanParts(text);
    expect(parsed.parts).toEqual([
      { title: 'First', done: false, persona: null, reason: null, chain: ['skip qa'] },
      { title: 'Second', done: false, persona: null, reason: null, chain: [] },
    ]);
    expect(parsed.warnings).toEqual([
      'parts line "stray prose" is not readable — expected "- [ ] <title>"',
      'part "First": persona "Not A Persona" is not a persona id',
      'part "First": unknown detail "mood"',
      'part "First": chain entry "frobnicate everything" is not readable',
    ]);
  });

  it('stops the chapter at the next heading and handles CRLF', () => {
    const text = '## Plan\r\n\r\n### Parts\r\n\r\n- [ ] One\r\n- [ ] Two\r\n\r\n### Acceptance criteria\r\n\r\n- [ ] `x`\r\n';
    expect(parsePlanParts(text).parts.map((p) => p.title)).toEqual(['One', 'Two']);
  });

  it('exposes a part’s chain as parsed entries', () => {
    expect(partChainEntries(B).map((e) => e.kind)).toEqual(['insert', 'skip']);
  });
});

describe('withPlanParts', () => {
  it('adds the chapter at the end of the Plan and leaves the rest alone', () => {
    const out = withPlanParts(TICKET, [A, C]);
    expect(out).toContain('- [ ] `npm test`\n\n### Parts\n\n- [ ] Split a file diff into hunks');
    expect(out).toContain('- [ ] Changelog and manual\n\n## Log\n\n- one\n');
    expect(out.startsWith(TICKET.slice(0, TICKET.indexOf('## Log') - 1))).toBe(true);
    expect(parsePlanParts(out).parts).toEqual([A, C]);
  });

  it('replaces an earlier chapter instead of adding a second one', () => {
    const once = withPlanParts(TICKET, [A, B, C]);
    const twice = withPlanParts(once, [C, A]);
    expect(twice.match(/### Parts/g)).toHaveLength(1);
    expect(parsePlanParts(twice).parts.map((p) => p.title)).toEqual([C.title, A.title]);
    expect(twice).toContain('### Acceptance criteria');
    expect(twice.endsWith('## Log\n\n- one\n')).toBe(true);
  });

  it('keeps a chapter that sits before other Plan headings intact on replace', () => {
    const text = TICKET.replace('### Acceptance criteria', '### Parts\n\n- [ ] Old\n- [ ] Older\n\n### Acceptance criteria');
    const out = withPlanParts(text, [A, C]);
    expect(out).toContain('- [ ] Changelog and manual\n\n### Acceptance criteria\n\n- [ ] `npm test`');
    expect(out).not.toContain('Older');
  });

  it('removes the chapter for one part or none — "Keep as one"', () => {
    const split = withPlanParts(TICKET, [A, B]);
    expect(withPlanParts(split, [A])).toBe(TICKET);
    expect(withPlanParts(split, [])).toBe(TICKET);
    expect(withPlanParts(TICKET, [A])).toBe(TICKET);
  });

  it('returns a file without a Plan unchanged', () => {
    expect(withPlanParts('# nothing', [A, B])).toBe('# nothing');
  });
});

describe('movePlanPart / deletePlanPart', () => {
  const none = new Set<number>();

  it('moves a part as a list edit', () => {
    expect(movePlanPart([A, B, C], 2, 0, none)).toEqual({ ok: true, parts: [C, A, B] });
    expect(movePlanPart([A, B, C], 0, 1, none)).toEqual({ ok: true, parts: [B, A, C] });
    expect(movePlanPart([A, B, C], 1, 1, none)).toEqual({ ok: true, parts: [A, B, C] });
  });

  it('refuses bad positions', () => {
    expect(movePlanPart([A, B], 0, 5, none)).toEqual({ ok: false, error: 'no such part position' });
    expect(movePlanPart([A, B], -1, 0, none)).toEqual({ ok: false, error: 'no such part position' });
    expect(deletePlanPart([A, B], 2, none)).toEqual({ ok: false, error: 'no such part position' });
  });

  it('locks a running part and keeps any part from jumping ahead of it', () => {
    const running = new Set([0]);
    expect(movePlanPart([A, B, C], 0, 2, running)).toEqual({ ok: false, error: '"Split a file diff into hunks" is running and cannot be moved' });
    expect(movePlanPart([A, B, C], 2, 0, running)).toEqual({ ok: false, error: 'a part cannot move ahead of one that is running' });
    expect(movePlanPart([A, B, C], 2, 1, running)).toEqual({ ok: true, parts: [A, C, B] });
    expect(deletePlanPart([A, B, C], 0, running)).toEqual({ ok: false, error: '"Split a file diff into hunks" is running and cannot be deleted' });
    expect(deletePlanPart([A, B, C], 1, running)).toEqual({ ok: true, parts: [A, C] });
  });
});
