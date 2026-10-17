import { describe, expect, it } from 'vitest';
import {
  acceptanceCommands,
  newTicketFileText,
  parseTicketFile,
  patchTicketFile,
} from './ticket-files';
import { parseHandover } from '../shared/tickets';
import {
  composeInstruction,
  parseWorkerValue,
  resolveAssignment,
} from './fleet/assignment';

/**
 * The fleet's assignment brain (M84, the owner's ruling): ticket pin >
 * phase handover pin > repo default > configured default > the fleet's
 * first worker — and every explicit-but-unreadable pin refuses instead
 * of falling through (ADR-0076: tolerate noise, never ambiguity).
 */

const newTicket = (): string =>
  newTicketFileText({
    id: 'T-0007',
    title: 'Add the thing',
    repo: 'lariscus',
    priority: 'normal',
    rank: 5000,
    firstPhase: 'inbox',
    now: new Date('2026-10-17T12:00:00Z'),
    actor: 'owner@box',
    description: 'It should work.',
  });

describe('the ticket file gains the fleet fields', () => {
  it('worker: is parsed as meta', () => {
    const base = newTicket();
    const pinned = patchTicketFile(base, {
      to: 'inbox',
      from: null,
      now: new Date('2026-10-17T12:01:00Z'),
      actor: 'owner@box',
      action: 'pin worker',
      setWorker: 'claude-code/sonnet',
    });
    expect(parseTicketFile(pinned, 'tickets/inbox/T-0007.md').meta.worker).toBe('claude-code/sonnet');
    const cleared = patchTicketFile(pinned, {
      to: 'inbox',
      from: null,
      now: new Date('2026-10-17T12:02:00Z'),
      actor: 'owner@box',
      action: 'clear worker',
      setWorker: '',
    });
    expect(parseTicketFile(cleared, 'tickets/inbox/T-0007.md').meta.worker).toBeNull();
    // The pin rides along a transition untouched.
    expect(parseTicketFile(pinned, 'tickets/inbox/T-0007.md').meta.run).toBeNull();
  });

  it('the run map stamps and clears (at most one live run)', () => {
    const base = newTicket();
    const stamped = patchTicketFile(base, {
      to: 'build',
      from: null,
      now: new Date('2026-10-17T12:03:00Z'),
      actor: 'agent@box:r1',
      action: 'run R-1 started (opencode)',
      run: { pid: 4242, 'started-at': '2026-10-17T12:03:00Z', stream: 'R-1' },
    });
    expect(parseTicketFile(stamped, 'tickets/build/T-0007.md').meta.run).toEqual({
      pid: 4242,
      'started-at': '2026-10-17T12:03:00Z',
      stream: 'R-1',
    });
    const cleared = patchTicketFile(stamped, {
      to: 'build',
      from: null,
      now: new Date('2026-10-17T12:04:00Z'),
      actor: 'agent@box:r1',
      action: 'run finished',
      clearRun: true,
    });
    expect(parseTicketFile(cleared, 'tickets/build/T-0007.md').meta.run).toBeNull();
  });

  it('acceptanceCommands reads the backticked checkboxes, in order', () => {
    const ticket = `${newTicket()}
## Plan

Do it in two steps.

### Acceptance criteria

- [ ] \`npm run verify:unit\` — exits 0
- [ ] \`npm run verify:pack\` — exits 0

### Out of scope

- [ ] \`not a criterion\`
`;
    expect(acceptanceCommands(ticket)).toEqual(['npm run verify:unit', 'npm run verify:pack']);
    expect(acceptanceCommands(newTicket())).toEqual([]);
  });
});

describe('worker values and the assignment ladder', () => {
  it('parses provider and optional model pin', () => {
    expect(parseWorkerValue('opencode')).toEqual({ provider: 'opencode', model: null });
    expect(parseWorkerValue('claude-code/sonnet')).toEqual({ provider: 'claude-code', model: 'sonnet' });
    expect(parseWorkerValue('codex')).toBeNull();
    expect(parseWorkerValue('claude-code/')).toEqual({ provider: 'claude-code', model: null });
  });

  it('ticket pin beats handover pin beats repo default beats configured default', () => {
    const base = {
      ticketWorker: null,
      handover: 'agent build-default',
      repoWorker: null,
      configuredDefault: null,
    };
    expect(resolveAssignment(base)).toEqual({
      ok: true,
      provider: 'opencode',
      model: null,
      source: 'default',
      promptRef: 'build-default',
    });
    expect(resolveAssignment({ ...base, configuredDefault: 'claude-code' }).source).toBe('default');
    expect(resolveAssignment({ ...base, configuredDefault: 'claude-code', repoWorker: 'opencode' })).toEqual({
      ok: true,
      provider: 'opencode',
      model: null,
      source: 'repo',
      promptRef: 'build-default',
    });
    expect(resolveAssignment({ ...base, repoWorker: 'opencode', handover: 'agent build-default@claude-code' })).toEqual({
      ok: true,
      provider: 'claude-code',
      model: null,
      source: 'handover',
      promptRef: 'build-default',
    });
    expect(
      resolveAssignment({
        ...base,
        handover: 'agent build-default@claude-code',
        ticketWorker: 'opencode/fast',
      }),
    ).toEqual({
      ok: true,
      provider: 'opencode',
      model: 'fast',
      source: 'ticket',
      promptRef: 'build-default',
    });
  });

  it('an explicit unreadable pin refuses; a stale repo default falls through', () => {
    const base = { handover: null, repoWorker: null, configuredDefault: 'opencode' };
    expect(resolveAssignment({ ...base, ticketWorker: 'codex' })).toEqual({
      ok: false,
      error: `the ticket's worker "codex" is unknown — use opencode or claude-code`,
    });
    expect(resolveAssignment({ ...base, ticketWorker: null, repoWorker: 'codex' })).toEqual({
      ok: true,
      provider: 'opencode',
      model: null,
      source: 'default',
      promptRef: null,
    });
  });

  it('non-agent handovers contribute no pin and no prompt', () => {
    const spec = parseHandover('manual');
    expect(spec.promptRef).toBeNull();
    expect(
      resolveAssignment({ ticketWorker: null, handover: 'manual', repoWorker: 'opencode', configuredDefault: null }),
    ).toEqual({ ok: true, provider: 'opencode', model: null, source: 'repo', promptRef: null });
  });
});

describe('composeInstruction — the deterministic run brief', () => {
  it('carries identity, checkout, gate and the phase prompt', () => {
    const text = composeInstruction({
      ticketId: 'T-0007',
      title: 'Add the thing',
      repo: 'lariscus',
      branch: 't/T-0007',
      worktreePath: 'C:\\fleet\\worktrees\\lariscus-T-0007',
      phase: 'build',
      description: 'It should work.',
      plan: 'Step one. Step two.',
      prompt: 'Follow the house style.',
      acceptance: ['npm run verify:unit'],
    });
    expect(text).toContain('ticket T-0007 — Add the thing');
    expect(text).toContain('branch t/T-0007');
    expect(text).toContain('repo lariscus');
    expect(text).toContain('It should work.');
    expect(text).toContain('Step one. Step two.');
    expect(text).toContain('Follow the house style.');
    expect(text).toContain('- `npm run verify:unit`');
  });
});
