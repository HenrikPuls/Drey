import { describe, expect, it } from 'vitest';
import { isManualPhase, MANUAL_TITLE, mergeChain, parseChainEntry, renderChainEntry, validateChain } from './chain-delta';
import { applyFlowOp } from './flow-edit';
import { chainPersonaAt, manualStepAfter } from './manual-gate';
import { humanPersona, isHumanPersona, parsePersonaFile, personaFileText } from './persona';
import { newTicketFileText, parseTicketFile, patchTicketFile } from './ticket-files';

/**
 * E10-6: the owner as a team member. The pure halves: the human persona
 * file, the `manual` step in the chain grammar and its guard, where a
 * ticket parks, and the `awaiting:` field.
 */

const PHASES = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'plan', title: 'Plan' },
  { id: 'build', title: 'Build' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

describe('the human persona (personas/you)', () => {
  it('round-trips as kind: human and reads as an agent when the key is absent', () => {
    const you = humanPersona('Henrik');
    const text = personaFileText(you);
    expect(text).toContain('kind: human');
    const back = parsePersonaFile('you', text);
    expect(back.kind).toBe('human');
    expect(back.title).toBe('Henrik');
    expect(isHumanPersona(back)).toBe(true);

    const agent = parsePersonaFile('ben', '---\ntitle: Ben\nrole: builder\n---\n');
    expect(agent.kind).toBe('agent');
    expect(personaFileText(agent)).not.toContain('kind:');
  });

  it('an unknown kind reads as an agent', () => {
    expect(parsePersonaFile('x', '---\ntitle: X\nkind: robot\n---\n').kind).toBe('agent');
  });
});

describe('the manual step in the chain grammar', () => {
  it('parses and renders insert manual(you, notify) after review', () => {
    const entry = parseChainEntry('insert manual(you, notify) after review');
    expect(entry).toEqual({ kind: 'insert', phase: 'manual', anchor: 'review', position: 'after', persona: 'you', notify: true });
    expect(renderChainEntry(entry!)).toBe('insert manual(you, notify) after review');
  });

  it('knows manual and manual-<word> ids only', () => {
    expect(isManualPhase('manual')).toBe(true);
    expect(isManualPhase('manual-qa')).toBe(true);
    expect(isManualPhase('manually')).toBe(false);
    expect(isManualPhase('review')).toBe(false);
  });

  it('merges into the chain with the manual title, and the guard accepts it without a pipeline directory', () => {
    const entries = [parseChainEntry('insert manual(you, notify) after review')!];
    expect(validateChain(PHASES, 'plan', entries)).toBeNull();
    const steps = mergeChain(PHASES, 'plan', entries);
    const manual = steps.find((s) => s.phase === 'manual');
    expect(manual).toMatchObject({ title: MANUAL_TITLE, inserted: true, persona: 'you', notify: true });
    expect(steps.map((s) => s.phase)).toEqual(['inbox', 'plan', 'build', 'review', 'manual', 'done']);
  });

  it('the guard still refuses a manual step twice, a skip of it and an unknown anchor', () => {
    const twice = [parseChainEntry('insert manual after review')!, parseChainEntry('insert manual after build')!];
    expect(validateChain(PHASES, 'plan', twice)).toMatch(/inserted twice/);
    expect(validateChain(PHASES, 'plan', [parseChainEntry('skip manual')!])).not.toBeNull();
    expect(validateChain(PHASES, 'plan', [parseChainEntry('insert manual after nowhere')!])).toMatch(/no phase "nowhere"/);
    // a second manual step has its own id
    const two = [parseChainEntry('insert manual after build')!, parseChainEntry('insert manual-qa after review')!];
    expect(validateChain(PHASES, 'plan', two)).toBeNull();
  });

  it('the flow editor adds a manual step and regenerates a canonical delta', () => {
    const edit = applyFlowOp(PHASES, 'plan', [], { op: 'insert', phase: 'manual', after: 3 });
    expect(edit.ok).toBe(true);
    if (edit.ok) {
      expect(edit.chain).toEqual(['insert manual after review']);
    }
  });
});

describe('where a ticket parks', () => {
  it('manualStepAfter finds the inserted manual step right after the working gate', () => {
    const entries = [parseChainEntry('insert manual(you) after review')!];
    expect(manualStepAfter(PHASES, 'review', entries)).toEqual({ phase: 'manual', persona: 'you' });
    expect(manualStepAfter(PHASES, 'build', entries)).toBeNull();
    expect(manualStepAfter(PHASES, 'review', [])).toBeNull();
  });

  it('a manual step without a pin is the owner\'s', () => {
    const entries = [parseChainEntry('insert manual after review')!];
    expect(manualStepAfter(PHASES, 'review', entries)).toEqual({ phase: 'manual', persona: null });
  });

  it('chainPersonaAt reads the delta\'s pin on the gate the ticket sits in', () => {
    const entries = [parseChainEntry('assign build you')!];
    expect(chainPersonaAt(PHASES, 'build', entries)).toBe('you');
    expect(chainPersonaAt(PHASES, 'review', entries)).toBeNull();
    expect(chainPersonaAt(PHASES, 'build', [])).toBeNull();
  });
});

describe('the awaiting field', () => {
  const NOW = new Date('2026-11-04T10:00:00Z');
  const base = (): string =>
    newTicketFileText({
      id: 'T-0001',
      title: 'A ticket',
      repo: 'drey',
      priority: 'normal',
      rank: 5000,
      firstPhase: 'plan',
      now: NOW,
      actor: 'owner@box',
      description: 'It should work.',
    });

  it('is written by setAwaiting and read back; a transition clears it', () => {
    const parked = patchTicketFile(base(), { to: 'plan', from: null, now: NOW, actor: 'agent@fleet', action: 'parked', setAwaiting: 'you' });
    expect(parseTicketFile(parked, 'tickets/plan/T-0001.md').meta.awaiting).toBe('you');

    const moved = patchTicketFile(parked, { to: 'build', from: 'plan', now: NOW, actor: 'owner@box' });
    expect(parseTicketFile(moved, 'tickets/build/T-0001.md').meta.awaiting).toBeUndefined();
  });

  it('a move that parks in the same step keeps it', () => {
    const moved = patchTicketFile(base(), { to: 'build', from: 'plan', now: NOW, actor: 'agent@fleet', setAwaiting: 'you' });
    expect(parseTicketFile(moved, 'tickets/build/T-0001.md').meta.awaiting).toBe('you');
  });
});
