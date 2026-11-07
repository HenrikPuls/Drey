import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type PipelinePhase, type TicketCard } from '../contracts/tickets';
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
      persona: null,
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

describe('composeRunRequest — the owner\'s columns (D-29)', () => {
  const inbox = phase('inbox', { title: 'Inbox', handover: 'manual', persona: 'you' });

  it('refuses a run from a manual column: the fleet takes nothing from it, whoever asks', () => {
    for (const asked of [{}, { workerChoice: 'opencode' }, { handover: 'fresh' as const }, { dispatchedBy: 'inbox' }]) {
      const result = composeRunRequest(base({ workingPhase: inbox, nextPhaseId: 'shaping', ...asked }));
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error).toBe("T-0001 sits in Inbox, the owner's column: the fleet takes nothing from it. Move it into an agent column to run it.");
    }
  });

  it('refuses a column with no handover at all (Done) the same way', () => {
    const result = composeRunRequest(base({ workingPhase: phase('done', { title: 'Done', handover: 'none' }), nextPhaseId: null }));
    expect(result.ok).toBe(false);
  });

  it('the owner\'s own dialog and Accept\'s commit step stay: neither takes a ticket for the fleet', () => {
    expect(composeRunRequest(base({ workingPhase: inbox, interactive: 'plan' })).ok).toBe(true);
    expect(composeRunRequest(base({ workingPhase: phase('ready', { handover: 'manual' }), nextPhaseId: null, commitStep: true })).ok).toBe(true);
  });

  it('an agent column still runs', () => {
    expect(composeRunRequest(base({ workingPhase: phase('building', { handover: 'agent build-default' }), nextPhaseId: 'ready' })).ok).toBe(true);
  });
});

describe('composeRunRequest — a store ticket has no file (D-30)', () => {
  const dk = { bin: 'dk', store: 'S:/board', dataDir: '', checkout: '', parkStage: null, retreatStage: null, trailers: false };

  it('the brief names the working copy, never the virtual path that exists on no disk', () => {
    const result = composeRunRequest(base({ dk }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.instruction).toMatch(/The ticket file: \S*_worktrees[\\/]T-0001\.ticket\.md — your working copy/);
    expect(result.request.instruction).toContain('the runner takes your changes back');
    expect(result.request.instruction).not.toMatch(/prioritized[\\/]T-0001\.md/);
    expect(result.request.ticketRelPath).toBe('tickets/prioritized/T-0001.md'); // the card's virtual path stays its identity
  });

  it('a file board keeps the real path', () => {
    const result = composeRunRequest(base());
    expect(result.ok && result.request.instruction).toMatch(/The ticket file: \S*prioritized[\\/]T-0001\.md — it lives in the tickets repo/);
  });
});

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


describe('persona dispatch (E3, ADR-0088)', () => {
  const PIA = { id: 'pia', worker: 'claude-code', model: 'sonnet', prompt: 'You are Pia.', memory: '', coaching: '' };

  it('a persona beats the assignment ring for provider and model', () => {
    const result = composeRunRequest(
      base({
        workingPhase: phase('plan', { handover: 'agent plan-default', worker: 'opencode', model: 'zai/glm-5.3' }),
        promptText: 'Phase template.',
        persona: PIA,
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.provider).toBe('claude-code');
    expect(result.request.model).toBe('sonnet');
    expect(result.persona).toBe('pia');
    expect(result.request.recordWorker).toBeUndefined(); // a persona is configuration, never a ticket worker pin
    expect(result.request.instruction).toContain('You are Pia.');
    expect(result.request.instruction).not.toContain('Phase template.');
  });

  it('a persona with a harness the fleet cannot run leaves the ring in charge', () => {
    const result = composeRunRequest(
      base({
        workingPhase: phase('plan', { handover: 'agent plan-default', worker: 'opencode', model: 'zai/glm-5.3' }),
        persona: { ...PIA, worker: 'api' },
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.provider).toBe('opencode'); // the ring's column pin stands
    expect(result.request.model).toBe('zai/glm-5.3');
    expect(result.persona).toBe('pia'); // the persona still dispatched — prompt, memory, stamp
  });

  it('a persona without a prompt keeps the phase template as the instruction base', () => {
    const result = composeRunRequest(base({ promptText: 'Phase template.', persona: { ...PIA, prompt: null } }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.instruction).toContain('Phase template.');
    expect(result.persona).toBe('pia');
  });

  it('an unreadable ring pin is not a refusal when a usable persona decided', () => {
    const pinned = card({ meta: { ...card().meta, worker: 'not-a-worker' } });
    const result = composeRunRequest(base({ card: pinned, persona: PIA }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.provider).toBe('claude-code');
  });

  it('the memory slice rides the variable tail: capped by lines and tokens, absent when empty', () => {
    const lines = [...Array(25).keys()].map((i) => `- lesson ${i + 1}`);
    const result = composeRunRequest(base({ persona: { ...PIA, memory: `# Memory\n\n${lines.join('\n')}\n` } }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    const instruction = result.request.instruction;
    expect(instruction).toContain('## Memory');
    expect(instruction).toContain('- lesson 25'); // newest
    expect(instruction).toContain('- lesson 6'); // oldest of the last 20
    expect(instruction).not.toContain('- lesson 5'); // the line cap drops it
    // persona-less bytes stay identical — no memory, no section
    const bare = composeRunRequest(base({ promptText: 'Phase template.' }));
    if (!bare.ok) {
      throw new Error(bare.error);
    }
    expect(bare.request.instruction).not.toContain('## Memory');
    const again = composeRunRequest(base({ promptText: 'Phase template.' }));
    if (!again.ok) {
      throw new Error(again.error);
    }
    expect(again.request.instruction).toBe(bare.request.instruction);
  });

  it('the memory slice rides the resume continuation; memory is not stable-digest material', () => {
    const memory = '# Memory\n\n- one lesson\n';
    const withMemory = composeRunRequest(base({ persona: { ...PIA, prompt: null, memory } }));
    if (!withMemory.ok) {
      throw new Error(withMemory.error);
    }
    expect(withMemory.request.continuationInstruction).toContain('## Memory');
    expect(withMemory.request.continuationInstruction).toContain('one lesson');
    // Two briefs differing ONLY in memory share the digest — the slice is
    // a variable part, like the diff stat; a changed prompt is a new brief.
    const otherMemory = composeRunRequest(base({ persona: { ...PIA, prompt: null, memory: '# Memory\n\n- other lesson\n' } }));
    if (!otherMemory.ok) {
      throw new Error(otherMemory.error);
    }
    expect(otherMemory.request.briefDigest).toBe(withMemory.request.briefDigest);
    const withPrompt = composeRunRequest(base({ persona: { ...PIA, memory } }));
    if (!withPrompt.ok) {
      throw new Error(withPrompt.error);
    }
    expect(withPrompt.request.briefDigest).not.toBe(withMemory.request.briefDigest);
  });
});

describe('scout runs (E8, concept §5.6)', () => {
  const SCOUT = { ...card().meta, form: 'scout' as const };
  const NO_CRITERIA = TICKET.replace('- [ ] `npm run verify:unit` — exits 0\n', '');

  function scoutCard(over: Partial<TicketCard> = {}): TicketCard {
    const { meta, ...rest } = over;
    return card({ ...rest, meta: { ...SCOUT, ...(meta ?? {}) } });
  }

  it('a scout ticket composes an exploration: no gate, no move, the repo as the read ground', () => {
    const result = composeRunRequest(
      base({
        card: scoutCard(),
        ticketText: NO_CRITERIA,
        workingPhase: phase('prioritized', { handover: 'agent plan-default' }),
        nextPhaseId: 'plan',
        nextPhaseClaims: true,
        dispatchedBy: 'prioritized',
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.form).toBe('scout');
    expect(result.request.gate).toBe('none');
    expect(result.request.acceptance).toEqual([]);
    expect(result.request.nextPhase).toBeNull(); // the ticket stays where it sits
    expect(result.request.nextPhaseDir).toBeNull();
    expect(result.request.claimIdentity).toBeNull();
    expect(result.request.worktreePath).toBe('W:/drey'); // the read ground, no worktree path
    expect(result.request.repoPath).toBe('W:/drey');
    expect(result.request.baseRef).toBeNull();
    expect(result.request.column).toBe('prioritized');
    expect(result.request.instruction).toContain('Scout discipline');
    expect(result.request.instruction).toContain('Read ground: W:/drey (the "drey" checkout)');
    expect(result.request.instruction).not.toContain('Completion discipline');
    // A ship ticket stays the default everywhere: no form, the normal gate.
    const ship = composeRunRequest(base({}));
    if (!ship.ok) {
      throw new Error(ship.error);
    }
    expect(ship.request.form).toBeUndefined();
    expect(ship.request.gate).toBe('commands');
  });

  it('no repo is no refusal for a scout — the tickets vault is the read ground', () => {
    const result = composeRunRequest(
      base({
        card: scoutCard({ meta: { ...SCOUT, repo: null, repos: [] } }),
        repo: null,
        ticketText: NO_CRITERIA,
      }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.worktreePath).toBe('V:/tickets');
    expect(result.request.instruction).toContain('Read ground: V:/tickets (the tickets vault)');
    // …while a ship ticket without a repo keeps refusing.
    expect(composeRunRequest(base({ repo: null })).ok).toBe(false);
  });

  it('a named repo without a checkout still refuses — for a scout too', () => {
    const result = composeRunRequest(base({ card: scoutCard(), repo: { ...REPO, path: null }, ticketText: NO_CRITERIA }));
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('no local path');
  });

  it('a persona scout signs the report and rides provider, model, prompt and memory', () => {
    const PIA = { id: 'pia', worker: 'claude-code', model: 'sonnet', prompt: 'You are Pia.', memory: '# Memory\n\n- lesson\n', coaching: '' };
    const result = composeRunRequest(base({ card: scoutCard(), ticketText: NO_CRITERIA, promptText: 'Phase template.', persona: PIA }));
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.provider).toBe('claude-code');
    expect(result.request.model).toBe('sonnet');
    expect(result.persona).toBe('pia');
    expect(result.request.instruction).toContain('by pia.');
    expect(result.request.instruction).toContain('You are Pia.');
    expect(result.request.instruction).not.toContain('Phase template.'); // the persona's prompt is the base
    expect(result.request.instruction).toContain('## Memory');
  });

  it('extra repos become read-only grounds in the brief — no prepared worktrees on the wire', () => {
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
    const result = composeRunRequest(
      base({ card: scoutCard({ meta: { ...SCOUT, repos: ['drey', 'lariscus'] } }), ticketText: NO_CRITERIA, extraRepos: [EXTRA] }),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.request.extraRepos).toBeUndefined();
    expect(result.request.instruction).toContain('- lariscus: E:/code/lariscus (read-only)');
    const refused = composeRunRequest(base({ card: scoutCard(), ticketText: NO_CRITERIA, extraRepos: [{ ...EXTRA, path: null }] }));
    expect(refused.ok).toBe(false);
  });
});
