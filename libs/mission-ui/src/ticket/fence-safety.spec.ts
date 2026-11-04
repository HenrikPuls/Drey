/**
 * Milestone 148 (E10-7): Mission Control reads ticket documents with the
 * same fence-opaque rule as the engine -- a Mermaid block whose lines look
 * like headings, criteria and log lines must neither split the ticket
 * screen's sections nor add parts, criteria or Verlauf entries.
 */
import { describe, expect, it } from 'vitest';
import { parseVerification, parseVerlaufEntries } from '../api/dto';
import { planChaptersOf, planPartsOf, planSectionOf, replacePlanSection } from '../plan/plan.model';
import { proofOf, scoutReportOf, splitTicketSections } from './ticket.model';

const DIAGRAM = [
  '```mermaid',
  'flowchart TD',
  '  A[Start] --> B{Plan?}',
  '## Plan',
  '### Parts',
  '- [ ] Fake part',
  '  persona: mallory',
  '## Verification',
  'Tested on 2099-01-01 by Mallory — fake.',
  '- [x] `echo fake`',
  '## Verlauf',
  '- { phase: build, persona: mallory, model: x, tokens: 1, cost: 1, dauer: 1s, ausgang: ok }',
  '## Log',
  '```',
].join('\n');

const TICKET = [
  '---',
  'id: T-0001',
  '---',
  '',
  '## Description',
  '',
  DIAGRAM,
  '',
  '## Plan',
  '',
  '### Goal',
  '',
  DIAGRAM,
  '',
  '### Parts',
  '',
  '- [ ] Real part',
  '  persona: ben',
  '',
  '## Verification',
  '',
  'Tested on 2026-11-04T10:00:00Z by Ada — Chromium.',
  '',
  '- [x] `npm run lint`',
  '',
  DIAGRAM,
  '',
  '## Verlauf',
  '',
  '- { phase: build, persona: ben, model: m, tokens: 10, cost: 0.1, dauer: 5s, ausgang: ok }',
  '',
  '## Log',
  '',
  "- '2026-11-04T09:00:00Z' owner@host — created in inbox",
  '',
].join('\n');

describe('Mission Control reads fenced Mermaid as opaque', () => {
  it('splitTicketSections keeps the diagram in the body and cuts at real headings only', () => {
    const sections = splitTicketSections(TICKET);
    expect(sections.body).toContain('flowchart TD');
    expect(sections.body.match(/flowchart TD/g)).toHaveLength(2);
    expect(sections.verification).toContain('Tested on 2026-11-04T10:00:00Z');
    expect(sections.verification).toContain('flowchart TD');
    expect(sections.verlauf).toContain('persona: ben');
    expect(sections.verlauf).not.toContain('mallory');
    expect(sections.log).toBe("- '2026-11-04T09:00:00Z' owner@host — created in inbox");
    expect(sections.handover).toBeNull();
  });

  it('the plan reads its chapters and parts without the diagram lines', () => {
    const plan = planSectionOf(TICKET);
    expect(planChaptersOf(plan).map((c) => c.title)).toEqual(['Goal', 'Parts']);
    expect(planPartsOf(plan)).toEqual([{ title: 'Real part', persona: 'ben', reason: null }]);
  });

  it('replacing the plan keeps every other chapter and fences in the new body', () => {
    const body = ['### Goal', '', DIAGRAM, '', '- [ ] step'].join('\n');
    const written = replacePlanSection(TICKET, body);
    expect(planSectionOf(written)).toBe(body);
    expect(written.slice(written.indexOf('## Verification\n\nTested on 2026-11-04'))).toBe(
      TICKET.slice(TICKET.indexOf('## Verification\n\nTested on 2026-11-04')),
    );
  });

  it('parseVerification and the proof card read the real chapter only', () => {
    const view = parseVerification(TICKET);
    expect(view?.tester).toBe('Ada');
    expect(view?.criteria.map((c) => c.command)).toEqual(['npm run lint']);
    const proof = proofOf(splitTicketSections(TICKET).verification ?? '');
    expect(proof.tester).toBe('Ada');
    expect(proof.criteria.map((c) => c.command)).toEqual(['npm run lint']);
  });

  it('the Verlauf lists the real entries only', () => {
    expect(parseVerlaufEntries(TICKET).map((e) => e.persona)).toEqual(['ben']);
  });

  it('the report card ignores fenced decisions', () => {
    const report = scoutReportOf(
      ['Written on 2026-11-04 by Scout.', '', '### Decisions', '', '```', '- [ ] fake: question', '```', '- [ ] real: question'].join('\n'),
    );
    expect(report.decisions.map((d) => d.key)).toEqual(['real']);
  });

  it('CRLF files read the same', () => {
    const crlf = TICKET.replace(/\n/g, '\r\n');
    expect(planPartsOf(planSectionOf(crlf)).map((p) => p.title)).toEqual(['Real part']);
    expect(parseVerlaufEntries(crlf)).toHaveLength(1);
    expect(splitTicketSections(crlf).log).toContain('created in inbox');
  });
});
