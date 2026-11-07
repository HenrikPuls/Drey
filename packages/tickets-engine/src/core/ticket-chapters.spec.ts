import { describe, expect, it } from 'vitest';
import { mergeWorkerChapters } from './ticket-chapters';

const GIVEN = [
  '---',
  'id: t-1',
  'stage: building',
  'rev: 4',
  '---',
  '',
  '## Description',
  '',
  'What and why.',
  '',
  '## Plan',
  '',
  'To be filled.',
  '',
  '## Verlauf',
  '',
  '- one',
  '',
  '## Log',
  '',
  '- start',
  '',
].join('\n');

describe('mergeWorkerChapters (D-30)', () => {
  it('nothing changed leaves the ticket byte for byte, the worker\'s line ends do not count as a change', () => {
    expect(mergeWorkerChapters(GIVEN, GIVEN, GIVEN)).toBe(GIVEN);
    expect(mergeWorkerChapters(GIVEN, GIVEN.replace(/\n/g, '\r\n'), GIVEN)).toBe(GIVEN);
  });

  it('a changed chapter replaces the ticket\'s own, a new one lands before the Verlauf', () => {
    const worker = GIVEN.replace('To be filled.', '### Acceptance criteria\n\n- [ ] `echo ok`').replace(
      '## Verlauf',
      '## Handover\n\nState: done\n\n## Verlauf',
    );
    const merged = mergeWorkerChapters(GIVEN, worker, GIVEN);
    expect(merged).toContain('- [ ] `echo ok`');
    expect(merged).not.toContain('To be filled.');
    expect(merged.indexOf('## Handover')).toBeGreaterThan(merged.indexOf('## Plan'));
    expect(merged.indexOf('## Handover')).toBeLessThan(merged.indexOf('## Verlauf'));
  });

  it('an owner\'s edit of another chapter during the run stands', () => {
    const owner = GIVEN.replace('What and why.', 'The owner sharpened this.');
    const worker = GIVEN.replace('To be filled.', 'The plan.');
    const merged = mergeWorkerChapters(GIVEN, worker, owner);
    expect(merged).toContain('The owner sharpened this.');
    expect(merged).toContain('The plan.');
  });

  it('the frontmatter and the Verlauf are not the worker\'s', () => {
    const worker = GIVEN.replace('stage: building', 'stage: done').replace('- one', '- forged');
    expect(mergeWorkerChapters(GIVEN, worker, GIVEN)).toBe(GIVEN);
  });

  it('the Log takes the worker\'s new lines at its end, after what came meanwhile', () => {
    const current = GIVEN.replace('- start', '- start\n- claim');
    const worker = GIVEN.replace('- start', '- start\n- worker line');
    const merged = mergeWorkerChapters(GIVEN, worker, current);
    expect(merged.split('## Log')[1]!.trim().split('\n')).toEqual(['- start', '- claim', '- worker line']);
  });

  it('a chapter the worker removed stays; a heading inside a code fence is no chapter', () => {
    const removed = GIVEN.replace('## Plan\n\nTo be filled.\n\n', '');
    expect(mergeWorkerChapters(GIVEN, removed, GIVEN)).toBe(GIVEN);
    const fenced = GIVEN.replace('To be filled.', '```\n## Not a chapter\n```');
    const merged = mergeWorkerChapters(GIVEN, fenced, GIVEN);
    expect(merged.match(/^## Not a chapter/gm)).toHaveLength(1);
    expect(merged.indexOf('## Not a chapter')).toBeLessThan(merged.indexOf('## Verlauf'));
  });
});
