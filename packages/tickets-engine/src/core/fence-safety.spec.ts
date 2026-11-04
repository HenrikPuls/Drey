/**
 * Milestone 148 (E10-7): fenced code is opaque to every ticket parser. One
 * realistic ticket carries Mermaid blocks whose lines look like every
 * structure the readers know; each reader and patcher must see only the
 * real ones, and a write must keep the fence byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { parseChanges, parseResult, planApprovedOf, storyOf } from '../contracts/changes';
import { changedLinesOf, planDelta, planSectionOf } from './plan-delta';
import { parsePlanParts, withPlanParts } from './plan-parts';
import { normalizePlanBody, withPlanSection } from './plan-section';
import { parseProofDeclaration } from './proof-mode';
import { parseFeedbackBlock, withReviewFeedback } from './review-feedback';
import { parseScoutReportSection, upsertScoutReportSection } from './scout';
import { refineTicket } from './ticket-refine';
import { acceptanceCommands, ticketSections, withLogLine } from './ticket-files';
import { appendVerlaufEntry, parseVerlaufEntries } from './verlauf';
import { parseVerificationSection, upsertVerificationSection } from './verification';

/** Every line that would be structure outside a fence. */
const DECOYS = [
  '## Plan',
  '### Parts',
  '- [ ] Fake part from the diagram',
  '  persona: mallory',
  '  chain: skip review',
  '### Acceptance criteria',
  '- [x] `echo fake` — decoy',
  '## Verification',
  'Tested on 2099-01-01 by Mallory — fake.',
  '## Verlauf',
  '- { phase: build, persona: mallory, model: x, tokens: 1, cost: 1, dauer: 1s, ausgang: ok }',
  '## Handover',
  'proof: tests',
  '### Review feedback',
  '- `evil.ts:1` — decoy',
  '## Report',
  '### Decisions',
  '- [ ] fake-key: fake question',
  '## Changes',
  '## Result',
  '## Log',
  "- '2099-01-01T00:00:00Z' owner@host — plan-review -> build",
  "- '2099-01-01T00:00:00Z' working: fake",
  '---',
];

function mermaid(fence = '```'): string {
  return [`${fence}mermaid`, 'flowchart TD', '  A[Start] --> B{Plan?}', ...DECOYS, '  B --> C[Done]', fence].join('\n');
}

const TICKET = [
  '---',
  'id: T-0001',
  'title: Diagram ticket',
  'phase: plan-review',
  '---',
  '',
  '## Description',
  '',
  'Intro text.',
  '',
  mermaid(),
  '',
  'After the diagram.',
  '',
  '## Plan',
  '',
  '### Goal',
  '',
  mermaid('~~~'),
  '',
  '### Parts',
  '',
  '- [ ] Real part one',
  '  persona: ben',
  '  reason: first',
  '- [x] Real part two',
  '  chain: insert security(ralf) after review',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] `npm run lint` — clean',
  '',
  '  ' + mermaid().split('\n').join('\n  '),
  '',
  '## Handover',
  '',
  'proof: ui — real',
  '',
  mermaid('````'),
  '',
  '## Verification',
  '',
  'Tested on 2026-11-04T10:00:00Z by Ada — Chromium.',
  '',
  '- [x] `npm run lint`',
  '',
  mermaid(),
  '',
  '### Findings',
  '',
  '- one real finding',
  '',
  '## Verlauf',
  '',
  '- { phase: build, persona: ben, model: m, tokens: 10, cost: 0.1, dauer: 5s, ausgang: ok }',
  '',
  mermaid(),
  '',
  '## Log',
  '',
  "- '2026-11-04T09:00:00Z' owner@host — created in inbox",
  '',
  mermaid(),
  '',
].join('\n');

const FENCE_LINES = TICKET.split('\n').filter((l) => l.startsWith('```') || l.startsWith('~~~'));

/** Every fenced block of `text`, in order — what a write must not change. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})mermaid$/.exec(lines[i]!);
    if (open !== null) {
      const close = lines.findIndex((line, j) => j > i && line.trim() === open[1]);
      blocks.push(lines.slice(i, close + 1).join('\n'));
      i = close;
    }
  }
  return blocks;
}

const BLOCKS = fencedBlocks(TICKET);

describe('the fixture', () => {
  it('has seven fences with decoys', () => {
    expect(BLOCKS).toHaveLength(7);
    expect(FENCE_LINES.length).toBeGreaterThan(0);
  });
});

describe('plan and parts', () => {
  it('reads only the real parts and warns about nothing', () => {
    const parsed = parsePlanParts(TICKET);
    expect(parsed.parts.map((p) => p.title)).toEqual(['Real part one', 'Real part two']);
    expect(parsed.parts[0]!.persona).toBe('ben');
    expect(parsed.parts[1]!.chain).toEqual(['insert security(ralf) after review']);
    expect(parsed.warnings).toEqual([]);
  });

  it('writes parts without touching any fence', () => {
    const parts = parsePlanParts(TICKET).parts;
    const written = withPlanParts(TICKET, [...parts, { title: 'Third', done: false, persona: null, reason: null, chain: [] }]);
    expect(fencedBlocks(written)).toEqual(BLOCKS);
    expect(parsePlanParts(written).parts.map((p) => p.title)).toEqual(['Real part one', 'Real part two', 'Third']);
  });

  it('removing the chapter ("keep as one") keeps the fences', () => {
    const written = withPlanParts(TICKET, [parsePlanParts(TICKET).parts[0]!]);
    expect(parsePlanParts(written).parts).toEqual([]);
    expect(fencedBlocks(written)).toEqual(BLOCKS);
    expect(written).toContain('### Acceptance criteria');
  });

  it('a Parts chapter that mermaid in the Plan precedes is still found; a mermaid-only Plan has none', () => {
    const only = '## Plan\n\n### Goal\n\n' + mermaid() + '\n\n## Log\n';
    expect(parsePlanParts(only).parts).toEqual([]);
    expect(withPlanParts(only, [])).toBe(only);
  });

  it('planSectionOf ends at the real next chapter, not at a fenced one', () => {
    const plan = planSectionOf(TICKET);
    expect(plan.startsWith('### Goal')).toBe(true);
    expect(plan).toContain('### Acceptance criteria');
    expect(plan.endsWith('```')).toBe(true);
    expect(plan).not.toContain('Tested on 2026-11-04');
  });

  it('withPlanSection replaces the whole chapter body and keeps what follows', () => {
    const body = ['### Goal', '', mermaid(), '', '- [ ] a step'].join('\n');
    const written = withPlanSection(TICKET, body);
    expect(planSectionOf(written)).toBe(body);
    const realHandover = '## Handover\n\nproof: ui';
    expect(written.slice(written.indexOf(realHandover))).toBe(TICKET.slice(TICKET.indexOf(realHandover)));
    expect(fencedBlocks(written)).toEqual([BLOCKS[0], mermaid(), ...BLOCKS.slice(3)]);
  });

  it('withPlanSection does not demote lines inside a fence of the new body', () => {
    const body = ['### Goal', '', mermaid()].join('\n');
    expect(normalizePlanBody(body)).toBe(body);
    expect(planSectionOf(withPlanSection(TICKET, body))).toBe(body);
    // A real "## " outside a fence is still demoted.
    expect(planSectionOf(withPlanSection(TICKET, '## Oops\ntext'))).toBe('### Oops\ntext');
  });

  it('a Plan written into a ticket without one lands before the real Log', () => {
    const noPlan = TICKET.replace(/## Plan\n\n### Goal[\s\S]*?(?=## Handover\n\nproof: ui)/, '');
    const written = withPlanSection(noPlan, 'Body');
    expect(written.indexOf('## Plan')).toBeLessThan(written.indexOf('## Verlauf'));
    expect(planSectionOf(written)).toBe('Body');
    expect(fencedBlocks(written)).toEqual(fencedBlocks(noPlan));
  });

  it('plan deltas diff the plan text as lines and survive fences', () => {
    const before = planSectionOf(TICKET);
    const after = before.replace('Real part one', 'Real part ONE');
    const delta = planDelta(before, after);
    expect(delta).not.toBeNull();
    expect(changedLinesOf(before, after).length).toBe(1);
    expect(planDelta(before, before)).toBeNull();
  });
});

describe('sections and acceptance criteria', () => {
  it('ticketSections cuts at real H2 headings only', () => {
    const sections = ticketSections(TICKET);
    expect(sections.description).toContain('After the diagram.');
    expect(sections.description).toContain('flowchart TD');
    expect(sections.plan.startsWith('### Goal')).toBe(true);
    expect(sections.plan).not.toContain('Tested on 2026-11-04');
    expect(sections.handover).toContain('proof: ui — real');
    expect(sections.handover).not.toContain('Tested on 2026-11-04');
  });

  it('acceptanceCommands ignores checkboxes and headings inside fences', () => {
    expect(acceptanceCommands(TICKET)).toEqual(['npm run lint']);
  });

  it('a fence inside the criteria chapter does not end it', () => {
    const text = [
      '## Plan',
      '',
      '### Acceptance criteria',
      '',
      '- [ ] `a`',
      '',
      '```mermaid',
      '### Not a heading',
      '- [ ] `b`',
      '```',
      '',
      '- [ ] `c`',
      '',
    ].join('\n');
    expect(acceptanceCommands(text)).toEqual(['a', 'c']);
  });

  it('a heading inside an unterminated fence is not structure until the next H2', () => {
    const text = '## Plan\n\n### Acceptance criteria\n\n- [ ] `a`\n\n```mermaid\n### Not a heading\n- [ ] `b`\n\n## Handover\n\nproof: tests\n';
    expect(acceptanceCommands(text)).toEqual(['a']);
    expect(ticketSections(text).handover).toBe('proof: tests');
  });
});

describe('proof, verification, verlauf', () => {
  it('the proof declaration is the real one, not the fenced one', () => {
    expect(parseProofDeclaration(TICKET)).toEqual({ mode: 'ui', reason: 'real' });
  });

  it('a fenced proof line alone declares nothing', () => {
    expect(parseProofDeclaration('## Handover\n\n' + mermaid() + '\n')).toBeNull();
  });

  it('reads the real verification section and no fenced criteria', () => {
    const report = parseVerificationSection(TICKET);
    expect(report).not.toBeNull();
    expect(report!.testedAt).toBe('2026-11-04T10:00:00Z');
    expect(report!.tester).toBe('Ada');
    expect(report!.criteria.map((c) => c.command)).toEqual(['npm run lint']);
    expect(report!.findings).toEqual(['one real finding']);
  });

  it('upserting the verification replaces the real chapter only', () => {
    const written = upsertVerificationSection(TICKET, '## Verification\n\nTested on 2026-11-05T00:00:00Z by Bo — x.\n');
    expect(parseVerificationSection(written)!.tester).toBe('Bo');
    expect(written).toContain('## Verlauf');
    expect(fencedBlocks(written)).toEqual([...BLOCKS.slice(0, 4), ...BLOCKS.slice(5)]);
  });

  it('upserting into a ticket whose only "## Verification" is fenced adds a chapter before the real Log', () => {
    const base = '## Plan\n\nx\n\n' + mermaid() + '\n\n## Log\n\n- l\n';
    const written = upsertVerificationSection(base, '## Verification\n\nTested on 2026-11-05T00:00:00Z by Bo — x.\n');
    expect(parseVerificationSection(written)!.tester).toBe('Bo');
    expect(written.indexOf('Tested on')).toBeLessThan(written.lastIndexOf('## Log\n\n- l'));
    expect(fencedBlocks(written)).toEqual(fencedBlocks(base));
  });

  it('reads Verlauf entries from the real chapter only', () => {
    const entries = parseVerlaufEntries(TICKET);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.persona).toBe('ben');
  });

  it('appends a Verlauf line after the real entries, ahead of the Log, fences untouched', () => {
    const written = appendVerlaufEntry(TICKET, '- { phase: test, persona: ada, model: m, tokens: 1, cost: 0, dauer: 1s, ausgang: ok }');
    expect(parseVerlaufEntries(written).map((e) => e.persona)).toEqual(['ben', 'ada']);
    expect(fencedBlocks(written)).toEqual(BLOCKS);
  });

  it('creates a Verlauf chapter before the real Log when only a fenced one exists', () => {
    const base = '## Plan\n\nx\n\n' + mermaid() + '\n\n## Log\n\n- l\n';
    const written = appendVerlaufEntry(base, '- { phase: test, persona: ada, model: m, tokens: 1, cost: 0, dauer: 1s, ausgang: ok }');
    expect(parseVerlaufEntries(written)).toHaveLength(1);
    expect(written.indexOf('## Verlauf')).toBeGreaterThan(written.indexOf('flowchart TD'));
    expect(written.indexOf('## Verlauf')).toBeLessThan(written.lastIndexOf('## Log\n\n- l'));
  });
});

describe('log, handover, report, changes', () => {
  const NOW = new Date('2026-11-04T12:00:00Z');

  it('appends the Log line to the real Log, not to a fenced "## Log"', () => {
    const written = withLogLine(TICKET, NOW, 'owner@host', 'did a thing');
    expect(written.endsWith("owner@host — did a thing\n") || written.includes('did a thing')).toBe(true);
    expect(written.indexOf('did a thing')).toBeGreaterThan(written.indexOf("created in inbox"));
    expect(fencedBlocks(written)).toEqual(BLOCKS);
  });

  it('a fenced "## Log" alone gets a real Log chapter appended', () => {
    const base = '---\nid: T-1\n---\n\n## Plan\n\n' + mermaid() + '\n';
    const written = withLogLine(base, NOW, 'owner@host', 'x');
    expect(written).toContain('\n## Log\n\n- ');
    expect(written.indexOf('\n## Log\n\n- ')).toBeGreaterThan(written.lastIndexOf('```'));
  });

  it('patches an inserted section through refineTicket without reading fenced headings', () => {
    const refined = refineTicket(TICKET, { header: {}, sections: { acceptance: '- [ ] `npm test`' } }, 'owner@host', NOW);
    expect(acceptanceCommands(refined)).toEqual(['npm test']);
    // The replaced chapter owned the third fence; every other one survives.
    expect(fencedBlocks(refined)).toEqual(BLOCKS.filter((_, i) => i !== 2));
    expect(refined).toContain('## Handover\n\nproof: ui — real');
  });

  it('review feedback goes into the real Handover and reads back', () => {
    const comments = [{ file: 'a.ts', line: 3, endLine: null, text: 'rename' }];
    const written = withReviewFeedback(TICKET, comments);
    expect(parseFeedbackBlock(written)).toEqual(comments);
    expect(parseFeedbackBlock(TICKET)).toEqual([]);
    expect(fencedBlocks(written)).toEqual(BLOCKS);
    expect(written.indexOf('### Review feedback\n', written.indexOf('proof: ui — real'))).toBeGreaterThan(-1);
  });

  it('the scout report reader and upsert ignore a fenced "## Report"', () => {
    expect(parseScoutReportSection(TICKET)).toBeNull();
    const written = upsertScoutReportSection(TICKET, '## Report\n\nWritten on 2026-11-04 by Scout.\n');
    expect(parseScoutReportSection(written)!.by).toBe('Scout');
    expect(fencedBlocks(written)).toEqual(BLOCKS);
  });

  it('Changes and Result come from real chapters only', () => {
    expect(parseResult(TICKET)).toBeNull();
    expect(parseChanges(TICKET)).toBeNull();
    const withResult = TICKET.replace("## Log\n\n- '2026", "## Result\n\nMerged.\n\n## Log\n\n- '2026");
    expect(parseResult(withResult)).toBe('Merged.');
  });

  it('the story and the plan-approved stamp ignore fenced Log lines', () => {
    expect(planApprovedOf(TICKET)).toBeNull();
    expect(storyOf(TICKET).items.map((i) => i.what)).toEqual(['Captured']);
  });
});

describe('CRLF files', () => {
  const crlf = TICKET.replace(/\n/g, '\r\n');

  it('parts, criteria and sections read the same', () => {
    expect(parsePlanParts(crlf).parts.map((p) => p.title)).toEqual(['Real part one', 'Real part two']);
    expect(acceptanceCommands(crlf)).toEqual(['npm run lint']);
    expect(ticketSections(crlf).handover).toContain('proof: ui');
  });

  it('verification and verlauf read the same', () => {
    expect(parseVerificationSection(crlf)!.criteria.map((c) => c.command)).toEqual(['npm run lint']);
    expect(parseVerlaufEntries(crlf)).toHaveLength(1);
    expect(parseProofDeclaration(crlf)).toEqual({ mode: 'ui', reason: 'real' });
  });
});
