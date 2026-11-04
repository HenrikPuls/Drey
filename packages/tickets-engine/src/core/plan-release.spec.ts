import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY_CONFIG } from '../contracts/tickets';
import { parseTicketFile } from './ticket-files';
import type { PlanPart } from './plan-parts';
import {
  blockerOf,
  indicesToMint,
  lockedIndices,
  matchPartTickets,
  partDescription,
  partStateOf,
  partTicketText,
  releaseLogText,
  startLineOf,
  type PartTicket,
} from './plan-release';

const part = (title: string, extra: Partial<PlanPart> = {}): PlanPart => ({ title, done: false, persona: null, reason: null, chain: [], ...extra });
const ticket = (id: string, title: string, phase = 'build', running = false): PartTicket => ({ id, title, phase, running });

describe('matchPartTickets', () => {
  it('matches by title, ignoring case and spacing, each ticket once', () => {
    const parts = [part('Capture window'), part('Dictation  hand-off'), part('Tidy-up')];
    const matched = matchPartTickets(parts, [ticket('T-0142', 'dictation hand-off'), ticket('T-0141', 'Capture window')]);
    expect(matched.map((m) => m?.id ?? null)).toEqual(['T-0141', 'T-0142', null]);
  });

  it('gives two parts of the same title two tickets in id order, never the same one twice', () => {
    const matched = matchPartTickets([part('Tidy'), part('Tidy')], [ticket('T-0150', 'Tidy'), ticket('T-0149', 'Tidy')]);
    expect(matched.map((m) => m?.id)).toEqual(['T-0149', 'T-0150']);
  });

  it('reads no tickets as nothing released', () => {
    expect(matchPartTickets([part('A')], [])).toEqual([null]);
  });
});

describe('partStateOf', () => {
  const queue = new Set(['inbox', 'prioritized', 'build']);
  it('names the five states', () => {
    expect(partStateOf(null, queue, 'done')).toBe('new');
    expect(partStateOf(ticket('T-1', 'a', 'build'), queue, 'done')).toBe('queued');
    expect(partStateOf(ticket('T-1', 'a', 'build', true), queue, 'done')).toBe('running');
    expect(partStateOf(ticket('T-1', 'a', 'commit'), queue, 'done')).toBe('active');
    expect(partStateOf(ticket('T-1', 'a', 'done'), queue, 'done')).toBe('done');
  });
});

describe('locks, start rule and release scope', () => {
  const matches = [ticket('T-0141', 'A', 'build', true), null, null];

  it('locks every released part', () => {
    expect([...lockedIndices(matches)]).toEqual([0]);
  });

  it('writes the start rule per card', () => {
    expect(startLineOf(0, matches)).toBe('Released as T-0141');
    expect(startLineOf(1, matches)).toBe('After part 1');
    expect(startLineOf(0, [null, null])).toBe('Runs now');
    expect(startLineOf(2, [null, null, null])).toBe('After part 2');
  });

  it('mints every new part, or only the first one without a ticket', () => {
    expect(indicesToMint(matches, 'all')).toEqual([1, 2]);
    expect(indicesToMint(matches, 'first')).toEqual([1]);
    expect(indicesToMint([null, null], 'first')).toEqual([0]);
    expect(indicesToMint([ticket('T-1', 'a')], 'all')).toEqual([]);
  });

  it('waits each part on the one before it', () => {
    const ids = new Map<number, string>([[0, 'T-0141']]);
    expect(blockerOf(0, ids)).toBeNull();
    expect(blockerOf(1, ids)).toBe('T-0141');
    expect(blockerOf(2, ids)).toBeNull();
  });
});

describe('the part ticket', () => {
  const base = {
    id: 'T-0142',
    parentId: 'T-0130',
    parentTitle: 'Voice capture for tickets',
    index: 1,
    total: 3,
    repo: 'drey',
    repos: [] as string[],
    priority: 'high' as const,
    priorities: DEFAULT_PRIORITY_CONFIG,
    firstPhase: 'inbox',
    phase: 'build',
    now: new Date('2026-11-04T10:00:00Z'),
    actor: 'owner@desk',
  };

  it('describes the part, its reason and where the plan lives', () => {
    const text = partDescription({ ...base, part: part('Dictation hand-off', { reason: 'extends the same window' }) });
    expect(text).toContain('Dictation hand-off');
    expect(text).toContain('extends the same window');
    expect(text).toContain('Part 2 of 3 of T-0130 (Voice capture for tickets)');
  });

  it('carries parent, persona, chain and blocked-by in a file the reader accepts', () => {
    const file = partTicketText({
      ...base,
      part: part('Dictation hand-off', { persona: 'ben', chain: ['insert security(ralf, notify) after build'] }),
      blockedBy: 'T-0141',
    });
    const parsed = parseTicketFile(file, 'tickets/30-build/T-0142.md');
    expect(parsed.meta.parent).toBe('T-0130');
    expect(parsed.meta.persona).toBe('ben');
    expect(parsed.meta.blockedBy).toEqual(['T-0141']);
    expect(parsed.meta.chain?.length).toBe(1);
    expect(parsed.meta.title).toBe('Dictation hand-off');
    expect(parsed.meta.repo).toBe('drey');
    expect(parsed.issues).toEqual([]);
    expect(file).toContain('created in inbox');
    expect(file).toContain('inbox -> build');
    expect(file).toMatch(/entered-build: '2026-11-04T10:00:00Z'/);
  });

  it('writes no persona, chain or blocker a part does not have', () => {
    const file = partTicketText({ ...base, index: 0, part: part('First'), blockedBy: null });
    expect(file).not.toContain('persona:');
    expect(file).not.toContain('chain:');
    expect(file).not.toContain('blocked-by:');
    expect(file).toContain('parent: T-0130');
  });

  it('words the parent log line', () => {
    expect(releaseLogText(['T-0141', 'T-0142'])).toBe('plan released: T-0141, T-0142');
  });
});
