import { describe, expect, it } from 'vitest';
import {
  acceptanceCommands,
  newTicketFileText,
  parseTicketFile,
  patchTicketFile,
  ticketSections,
} from './ticket-files';
import { parseHandover } from '../shared/tickets';
import {
  composeInstruction,
  parseWorkerValue,
  resolveAssignment,
} from './fleet/assignment';
import { DEFAULT_FLEET_CAPS } from './fleet/protocol';

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
    expect(resolveAssignment({ ...base, configuredDefault: 'claude-code' })).toMatchObject({ source: 'default' });
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

describe('composeInstruction — the context pack (T-0048)', () => {
  const baseInput = (over: Partial<Parameters<typeof composeInstruction>[0]> = {}): Parameters<typeof composeInstruction>[0] => ({
    ticketId: 'T-0007',
    title: 'Add the thing',
    repo: 'lariscus',
    branch: 't/T-0007',
    worktreePath: 'C:\\fleet\\worktrees\\lariscus-T-0007',
    phase: 'build',
    description: 'It should work.',
    plan: 'Files: a.ts. Steps: one.',
    prompt: 'You are the build step. Work the plan.',
    acceptance: ['npm run verify:unit'],
    ticketFile: 'E:/tickets/tickets/build/T-0007.md',
    repoInstructions: '# Repo rules\nFollow the house style.',
    diffStat: null,
    gateFailure: null,
    caps: DEFAULT_FLEET_CAPS,
    ...over,
  });

  it('orders the pack: repo instructions, phase template, plan, then the variable parts', () => {
    const { text } = composeInstruction(baseInput());
    const order = [
      text.indexOf('# Repo rules'),
      text.indexOf('You are the build step.'),
      text.indexOf('## Plan'),
      text.indexOf('You are working ticket T-0007'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at >= 0)).toBe(true);
  });

  it('the prefix through the plan header is byte-identical for two tickets of the same repo and phase', () => {
    const a = composeInstruction(baseInput()).text;
    const b = composeInstruction(
      baseInput({
        ticketId: 'T-0042',
        title: 'A different ticket entirely',
        description: 'Another description.',
        plan: 'Files: b.ts. Steps: two.',
        diffStat: ' src/x.ts | 2 +-\n 1 file changed',
        gateFailure: '`npm run verify:unit` failed\n\nexit 1',
      }),
    ).text;
    const prefixOf = (text: string): string => text.slice(0, text.indexOf('## Plan'));
    expect(prefixOf(a)).toBe(prefixOf(b));
  });

  it('a repo without agent instructions starts straight at the phase template', () => {
    const { text } = composeInstruction(baseInput({ repoInstructions: null }));
    expect(text.startsWith('You are the build step.')).toBe(true);
  });

  it('carries the checkout, the ticket file and the gate commands in the variable parts', () => {
    const { text } = composeInstruction(baseInput());
    expect(text).toContain('The ticket file: E:/tickets/tickets/build/T-0007.md');
    expect(text).toContain('do not search the disk');
    expect(text).toContain('ticket T-0007 — Add the thing');
    expect(text).toContain('branch t/T-0007');
    expect(text).toContain('repo lariscus');
    expect(text).toContain('It should work.');
    expect(text).toContain('- `npm run verify:unit`');
    expect(text).toContain('Completion discipline');
  });

  it('a retry carries the previous run\'s gate failure as its tail; a first run has no such section', () => {
    const failure = [...Array(80).keys()].map((i) => `row ${i + 1}: assertion ${i + 1} failed`).join('\n');
    const retry = composeInstruction(baseInput({ gateFailure: `\`npm test\` failed\n\n${failure}` }));
    expect(retry.text).toContain('The previous run failed the machine gate — fix this first');
    // The tail: the LAST lines survive, the head does not.
    expect(retry.text).toContain('row 80: assertion 80 failed');
    expect(retry.text).not.toContain('row 1: assertion 1 failed');
    expect(retry.truncations).toEqual([{ section: 'gateFailure', originalSize: Buffer.byteLength(`\`npm test\` failed\n\n${failure}`, 'utf8') }]);

    const first = composeInstruction(baseInput());
    expect(first.text).not.toContain('The previous run failed the machine gate');
    expect(first.truncations).toEqual([]);
  });

  it('the diff stat is injected head-capped and reported; nothing leaks when there is none', () => {
    const stat = [...Array(80).keys()].map((i) => ` src/file${i + 1}.ts | ${i + 1} ++++`).join('\n');
    const withStat = composeInstruction(baseInput({ diffStat: stat }));
    expect(withStat.text).toContain('git diff --stat');
    expect(withStat.text).toContain('src/file1.ts');
    expect(withStat.text).not.toContain('src/file80.ts');
    expect(withStat.truncations).toEqual([{ section: 'diffStat', originalSize: Buffer.byteLength(stat, 'utf8') }]);

    const without = composeInstruction(baseInput({ diffStat: null }));
    expect(without.text).not.toContain('git diff --stat');
    expect(without.truncations).toEqual([]);
  });

  it('custom caps replace the defaults', () => {
    const failure = [...Array(10).keys()].map((i) => `line ${i + 1}`).join('\n');
    const { text } = composeInstruction(
      baseInput({ gateFailure: failure, caps: { gateFailureLines: 2, gateFailureBytes: 4096, diffStatLines: 50, diffStatBytes: 4096 } }),
    );
    expect(text).toContain('line 9\nline 10');
    expect(text).not.toContain('line 8');
  });

  it('no ## Log content ever leaks into an instruction', () => {
    // ticketSections is what feeds the composer; a Log section must not ride along.
    const ticket = `${newTicket()}
## Plan

Do it in two steps.

## Log

- 2026-10-18 owner@box SECRET-LOG-LINE
`;
    const sections = ticketSections(ticket);
    expect(sections.plan).not.toContain('SECRET-LOG-LINE');
    const { text } = composeInstruction(baseInput({ plan: sections.plan, description: sections.description }));
    expect(text).not.toContain('SECRET-LOG-LINE');
  });

  it('tells the worker the quoted ticket is complete, so it does not read the file again (req-55)', () => {
    const base = {
      ticketId: 'T-0007',
      title: 'Add the thing',
      repo: null,
      branch: 't/T-0007',
      worktreePath: 'W',
      phase: 'build',
      description: 'It should work.',
      prompt: null,
      acceptance: [],
      ticketFile: 'E:/tickets/T-0007.md',
      repoInstructions: null,
      diffStat: null,
      gateFailure: null,
      caps: DEFAULT_FLEET_CAPS,
    };
    const { text } = composeInstruction({ ...base, plan: 'Step one.' });
    expect(text).toContain('description and plan are quoted in full in this brief — do not read the ticket file');
    expect(text.indexOf('quoted in full in this brief')).toBeLessThan(text.indexOf('What and why:'));
    expect(composeInstruction({ ...base, plan: null }).text).toContain('description is quoted in full in this brief');
    expect(composeInstruction({ ...base, plan: null, ticketFile: undefined }).text).not.toContain('quoted in full');
  });

  it("names the linked toolchain and forbids an install, only when the repo links something (req-56)", () => {
    const base = {
      ticketId: 'T-0007',
      title: 'Add the thing',
      repo: null,
      branch: 't/T-0007',
      worktreePath: 'W',
      phase: 'build',
      description: 'It should work.',
      plan: null,
      prompt: null,
      acceptance: [],
      repoInstructions: null,
      diffStat: null,
      gateFailure: null,
      caps: DEFAULT_FLEET_CAPS,
    };
    const { text } = composeInstruction({ ...base, links: ['.tools', 'node_modules'] });
    expect(text).toContain('Toolchain: `.tools`, `node_modules` are linked into the checkout');
    expect(text).toContain('Do not run an install');
    expect(composeInstruction(base).text).not.toContain('Toolchain:');
  });

  it('tells every worker how to ask the owner (req-64)', () => {
    const { text } = composeInstruction({
      ticketId: 'T-0007',
      title: 'Add the thing',
      repo: null,
      branch: 't/T-0007',
      worktreePath: 'W',
      phase: 'build',
      description: '',
      plan: null,
      prompt: null,
      acceptance: [],
      repoInstructions: null,
      diffStat: null,
      gateFailure: null,
      caps: DEFAULT_FLEET_CAPS,
    });
    expect(text).toContain('starts with `QUESTION:`');
    expect(text.trimEnd().endsWith("go into the ticket's Log.")).toBe(true);
  });
});
