import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type PipelinePhase, type TicketCard } from '../../shared/tickets';
import { composeRunRequest } from './request';

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
      worker: null,
      priority: 'normal',
      rank: 5000,
      branch: null,
      claimedBy: null,
      claimedAt: null,
      run: null,
      references: [],
      parkedReason: null,
      parkedAt: null,
      entered: {},
    },
    pinned: false,
    worker: 'opencode',
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

const REPO = { name: 'drey', url: 'https://example.test/drey.git', branch: 'main', policy: null, path: 'W:/drey', worker: null };

function base(over: Partial<Parameters<typeof composeRunRequest>[0]> = {}): Parameters<typeof composeRunRequest>[0] {
  return {
    card: card(),
    ticketText: TICKET,
    vaultPath: 'V:/tickets',
    workingPhase: null,
    nextPhaseId: 'plan',
    nextPhaseClaims: false,
    repo: REPO,
    promptText: null,
    defaultWorker: 'opencode',
    permissionMode: 'accept-edits',
    gitPath: '',
    workerChoice: null,
    ...over,
  };
}

describe('composeRunRequest', () => {
  it('builds a dispatched run: the pull stays in its phase, the move follows the working column', () => {
    const result = composeRunRequest(
      base({
        workingPhase: phase('plan', { handover: 'agent plan-default', worker: 'opencode', model: 'zai/glm-5.3', workers: 2 }),
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
});
