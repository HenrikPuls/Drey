import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type PipelinePhase, type TicketCard } from '../../shared/tickets';
import { composeRunRequest } from './request';
import type { RunRequest } from './protocol';

/**
 * The one RunRequest builder both call sites share (M85): the board
 * service (an owner run) and the orchestrator (a dispatched run).
 */

function phase(id: string, over: Partial<PipelinePhase> = {}): PipelinePhase {
  return phaseWithoutPoolKeys({ id, title: id, wip: null, claim: false, handover: 'manual', ...over });
}

function card(over: Partial<TicketCard> = {}): TicketCard {
  return {
    id: 'T-0001',
    path: 'tickets/prioritized/T-0001.md',
    phase: 'prioritized',
    meta: {
      id: 'T-0001',
      title: 'Add the thing',
      repo: 'drey',
      repos: ['drey'],
      worker: null,
      track: null,
      priority: 'normal',
      rank: 5000,
      branch: null,
      claimedBy: null,
      claimedAt: null,
      run: null,
      references: [],
      blockedBy: [],
      parkedReason: null,
      parkedAt: null,
      interactive: false,
      entered: {},
    },
    worker: 'opencode',
    blocked: [],
    blocks: [],
    issues: [],
    ...over,
  };
}

const TICKET = [
  '---',
  'id: T-0001',
  'title: "Add the thing"',
  'repo: drey',
  'priority: normal',
  'rank: 5000',
  'branch: t/T-0001',
  "entered-prioritized: '2026-10-18T10:00:00Z'",
  '---',
  '',
  '## Description',
  '',
  'It should work.',
  '',
  '## Plan',
  '',
  'Step one.',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] `npm run verify:unit` — exits 0',
  '',
  '## Log',
  '',
].join('\n');

const REPO = { name: 'drey', url: 'https://example.test/drey.git', branch: 'main', policy: null, path: 'W:/drey', worker: null, worktrees: null, launch: null, instructions: null };

function base(over: Partial<Parameters<typeof composeRunRequest>[0]> = {}): Parameters<typeof composeRunRequest>[0] {
  return {
    card: card(),
    ticketText: TICKET,
    vaultPath: 'V:/tickets',
    workingPhase: null,
    nextPhaseId: 'plan',
    nextPhaseDir: null,
    pushRemote: null,
    nextPhaseClaims: false,
    repo: REPO,
    promptText: null,
    defaultWorker: 'opencode',
    permissionMode: 'accept-edits',
    gitPath: '',
    workerChoice: null,
    repoInstructions: null,
    diffStat: null,
    gateFailure: null,
    ...over,
  };
}

describe('composeRunRequest', () => {
  it('builds a dispatched run: the pull stays in its phase, the move follows the working column', () => {
    const result = composeRunRequest(
      base({
        workingPhase: phase('plan', { handover: 'agent plan-default', worker: 'opencode', model: 'zai/glm-5.3' }),
        nextPhaseId: 'plan-review',
        dispatchedBy: 'plan',
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.phase).toBe('prioritized'); // where the file sits
    expect(result.request.column).toBe('plan'); // the pool whose slot it takes
    expect(result.request.nextPhase).toBe('plan-review');
    expect(result.request.provider).toBe('opencode');
    expect(result.request.model).toBe('zai/glm-5.3');
    expect(result.request.claimIdentity).toBeNull();
    expect(result.request.recordWorker).toBeUndefined(); // the orchestrator never re-pins
    expect(result.request.instruction).toContain('Completion discipline');
    expect(result.request.instruction).toContain('It should work.');
  });

  it('a claim-flagged move target stamps the agent identity', () => {
    const result = composeRunRequest(base({ nextPhaseId: 'build', nextPhaseClaims: true }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.claimIdentity).toMatch(/^agent@/);
  });

  it('an owner run records the dialog choice and carries no column', () => {
    const result = composeRunRequest(
      base({ workingPhase: phase('build', { handover: 'agent build-default' }), nextPhaseId: 'review', workerChoice: 'claude-code/sonnet' }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.provider).toBe('claude-code');
    expect(result.request.model).toBe('sonnet');
    expect(result.request.recordWorker).toBe('claude-code/sonnet');
    expect(result.request.column).toBeUndefined();
  });

  it('threads the handover ask through — explicit from the dialog, auto from the dispatcher (T-0049)', () => {
    const explicit = composeRunRequest(base({ handover: 'resume-compact' }));
    expect(explicit.ok && explicit.request.handover).toBe('resume-compact');
    const auto = composeRunRequest(base({ dispatchedBy: 'build', handover: 'auto' }));
    expect(auto.ok && auto.request.handover).toBe('auto');
    // Absent — every older caller — stays absent: the supervisor reads fresh.
    const absent = composeRunRequest(base({}));
    expect(absent.ok && absent.request.handover).toBeUndefined();
  });

  it('an interactive dialog composes without acceptance criteria, carries the mode, and moves nothing (req-65)', () => {
    const noCriteria = TICKET.replace('- [ ] `npm run verify:unit` — exits 0\n', '');
    const result = composeRunRequest(
      base({
        ticketText: noCriteria,
        workingPhase: phase('plan', { handover: 'agent plan-default', interactive: 'plan-interactive-default' }),
        nextPhaseId: 'plan-review',
        nextPhaseDir: '20-plan-review',
        interactive: 'plan',
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.interactive).toBe('plan');
    expect(result.request.nextPhase).toBeNull(); // the owner moves the ticket
    expect(result.request.nextPhaseDir).toBeNull();
    expect(result.request.claimIdentity).toBeNull();
    expect(result.request.instruction).toContain('Dialog discipline');
    expect(result.request.instruction).not.toContain('Completion discipline');
    expect(result.request.instruction).toContain('QUESTION:'); // the asking protocol rides the dialog too

    // A dispatched (non-interactive) compose keeps every default.
    const normal = composeRunRequest(base({}));
    if (!normal.ok) {
      throw new Error(normal.error);
    }
    expect(normal.request.interactive).toBeUndefined();
    expect(normal.request.instruction).toContain('Completion discipline');
  });

  it('the assignment ring: ticket pin over column over handover pin over repo over default', () => {
    const pinned = card({ meta: { ...card().meta, worker: 'claude-code' } });
    const ticketWins = composeRunRequest(
      base({
        card: pinned,
        workingPhase: phase('plan', { handover: 'agent plan-default', worker: 'opencode' }),
      }),
    );
    expect(ticketWins.ok && ticketWins.request.provider).toBe('claude-code');

    const columnWins = composeRunRequest(
      base({ workingPhase: phase('plan', { handover: 'agent plan-default@claude-code', worker: 'opencode' }) }),
    );
    expect(columnWins.ok && columnWins.request.provider).toBe('opencode');

    const handoverWins = composeRunRequest(
      base({ workingPhase: phase('plan', { handover: 'agent plan-default@claude-code' }) }),
    );
    expect(handoverWins.ok && handoverWins.request.provider).toBe('claude-code');
  });

  it('refuses the honest reasons: no repo, no checkout, no gate', () => {
    const noRepo = composeRunRequest(base({ repo: null }));
    expect(noRepo.ok).toBe(false);
    const noPath = composeRunRequest(base({ repo: { ...REPO, path: null } }));
    expect(noPath.ok).toBe(false);
    const noGate = composeRunRequest(
      base({ ticketText: TICKET.replace('- [ ] `npm run verify:unit` — exits 0', 'prose only') }),
    );
    expect(noGate.ok).toBe(false);
  });

  it('threads the context pack into the instruction and reports its truncations', () => {
    const failure = [...Array(80).keys()].map((i) => `row ${i + 1}: assertion ${i + 1} failed`).join('\n');
    const result = composeRunRequest(
      base({
        repoInstructions: '# Repo rules',
        diffStat: ' src/a.ts | 2 +-',
        gateFailure: `\`npm run verify:unit\` failed\n\n${failure}`,
        caps: { gateFailureLines: 40, gateFailureBytes: 4096, diffStatLines: 50, diffStatBytes: 4096 },
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.instruction).toContain('# Repo rules');
    expect(result.request.instruction).toContain('src/a.ts | 2 +-');
    expect(result.request.instruction).toContain('row 80: assertion 80 failed');
    expect(result.truncations).toEqual([{ section: 'gateFailure', originalSize: Buffer.byteLength(`\`npm run verify:unit\` failed\n\n${failure}`, 'utf8') }]);
  });

  it('carries a resume continuation without the stable brief, and a digest only the stable parts move (req-80)', () => {
    const compose = (over: Parameters<typeof base>[0]): RunRequest => {
      const result = composeRunRequest(base({ repoInstructions: '# Repo rules', ...over }));
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.request;
    };
    const first = compose({ diffStat: ' src/a.ts | 2 +-', gateFailure: 'gate red: x failed' });
    expect(first.continuationInstruction).toContain('src/a.ts | 2 +-');
    expect(first.continuationInstruction).toContain('gate red: x failed');
    expect(first.continuationInstruction).not.toContain('# Repo rules');
    expect(first.continuationInstruction!.length).toBeLessThan(first.instruction.length);

    const retry = compose({ diffStat: ' src/b.ts | 9 +++', gateFailure: 'other failure' });
    expect(retry.briefDigest).toBe(first.briefDigest);
    const newRules = compose({ repoInstructions: '# Other rules' });
    expect(newRules.briefDigest).not.toBe(first.briefDigest);
  });
});

describe('multi-repo runs (req-72)', () => {
  const EXTRA = {
    name: 'lariscus',
    url: 'https://example.invalid/lariscus.git',
    branch: 'main',
    path: 'E:/code/lariscus',
    policy: null,
    worker: null,
    worktrees: null,
    launch: null,
    instructions: null,
  };

  it('carries one worktree per extra repo and names them in the brief', () => {
    const result = composeRunRequest(base({ extraRepos: [EXTRA] }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.extraRepos).toHaveLength(1);
    expect(result.request.extraRepos![0]).toMatchObject({ name: 'lariscus', repoPath: 'E:/code/lariscus', baseRef: 'main' });
    expect(result.request.extraRepos![0]!.worktreePath).toContain('T-0001');
    expect(result.request.instruction).toContain('Further repositories this ticket names');
    expect(result.request.instruction).toContain('lariscus');
  });

  it('skips the primary when it appears twice and omits the field on single-repo tickets', () => {
    const twice = composeRunRequest(base({ extraRepos: [REPO] }));
    if (!twice.ok) {
      throw new Error(twice.error);
    }
    expect(twice.request.extraRepos).toBeUndefined();
    expect(composeRunRequest(base()).ok).toBe(true);
  });

  it('refuses an extra repo without a checkout', () => {
    const result = composeRunRequest(base({ extraRepos: [{ ...EXTRA, path: null }] }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('lariscus') });
  });
});
