import { describe, expect, it } from 'vitest';
import { EngineBoardService } from './board-service';
import type { EngineHost, EngineVault } from './host';
import type { FleetPort } from './host';
import { TicketsGit } from '../core/tickets-git';
import { normalizeFleetCaps, normalizeFleetHandover, normalizeFleetPools, type RunInfo } from '../fleet/protocol';
import {
  parseFriction,
  parseImprovements,
  renderImprovements,
  type ImprovementProposal,
} from '../core/improvements';
import type { ImprovementDraft } from '../core/improvements';

/**
 * E6: the self-improvement loop's board-service write paths — the
 * aggregation (proposal minting, friction truncation), the 1:1 decision
 * (target application through the yaml doc-mutation discipline, the
 * always-lesson memory append) and the two reads. In-memory vault, no
 * git (locate() answers null, so every commit degrades to the usual
 * unversioned warning).
 */

const VAULT: EngineVault = { id: 'v', name: 'vault', path: '/vault', exists: true, active: true };

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
---
The pipeline.
`;

const PERSONA = `---
title: Pia
role: builder
worker: claude-code
models:
  default: opus # the everyday model
  pool: [opus, sonnet]
  router: off
color: '#a78bfa'
skills: []
---
Who Pia is.
`;

function hostOf(files: Map<string, string>): EngineHost {
  return {
    listVaults: async () => [VAULT],
    read: async (_vaultId, path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`missing: ${path}`);
      }
      return text;
    },
    writeAnnounced: async (_vaultId, path, text) => {
      files.set(path, text);
    },
    write: async (_vaultId, path, text) => {
      files.set(path, text);
    },
    listMarkdownFiles: async () => [...files.keys()].filter((p) => p.endsWith('.md')),
    resolveAssetPath: () => null,
    announceChanges: () => undefined,
    markManaged: () => undefined,
    configGet: async () => undefined,
    configSet: async () => undefined,
    emitBoardChanged: () => undefined,
    log: () => undefined,
    userRoot: '/home',
    pickFolder: async () => null,
    revealPath: async () => '',
    launchInConsole: () => undefined,
  };
}

function serviceOf(files: Map<string, string>, runs: readonly RunInfo[] = []): EngineBoardService {
  // A git whose every command fails: locate() answers null, so the one
  // commit per mutation degrades to the honest unversioned warning.
  const git = new TicketsGit(() => 'git', async () => {
    throw new Error('no git in the spec');
  });
  const fleet: FleetPort = {
    runs: async () => runs,
    start: async () => ({ ok: false, error: 'not in the spec' }),
    configureChain: async () => undefined,
  };
  return new EngineBoardService(
    hostOf(files),
    git,
    'opencode',
    'accept-edits',
    '',
    fleet,
    '/fleet',
    normalizeFleetCaps({}),
    normalizeFleetPools({}),
    normalizeFleetHandover({}),
    'owner@test',
  );
}

function seeded(): Map<string, string> {
  return new Map([
    ['tickets/_meta/pipeline.md', PIPELINE],
    ['tickets/_meta/personas/pia/persona.md', PERSONA],
    ['tickets/_meta/personas/pia/prompt.md', 'The old prompt.\n'],
    [
      'tickets/_meta/personas/pia/friction.md',
      '# Friction\n\n- 2026-11-01 · T-0007 · guessed the order.md shape\n- 2026-11-02 · Context pack missed the ledger\n',
    ],
  ]);
}

function proposal(partial: Partial<ImprovementProposal> & { id: string }): ImprovementProposal {
  return {
    state: 'open',
    target: 'prompt.md',
    title: 'A proposal',
    evidence: [],
    content: 'content',
    lesson: null,
    at: '2026-11-02T10:00:00Z',
    decidedAt: null,
    ...partial,
  };
}

const DRAFTS: readonly ImprovementDraft[] = [
  {
    target: 'prompt.md',
    title: 'Order the context pack by name',
    evidence: ['2026-11-01 · T-0007 · guessed the order.md shape'],
    content: 'Read the pack first.',
    lesson: 'Keep the pack recipe explicit.',
  },
  {
    target: 'memory',
    title: 'Remember the ledger',
    evidence: [],
    content: 'Check the ledger\nbefore dispatch.',
    lesson: null,
  },
];

describe('personaImprovements (E6 read)', () => {
  it('returns the persona, the proposals and both counts', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', {
        lastAggregation: '2026-11-02T10:00:00Z',
        proposals: [proposal({ id: 'imp-1' }), proposal({ id: 'imp-2', state: 'dismissed', decidedAt: '2026-11-02T11:00:00Z' })],
      }),
    );
    const reply = await serviceOf(files).personaImprovements('pia');
    expect(reply.ok).toBe(true);
    if (!reply.ok) {
      return;
    }
    expect(reply.persona.title).toBe('Pia');
    expect(reply.proposals.map((p) => p.id)).toEqual(['imp-1', 'imp-2']);
    expect(reply.openCount).toBe(1);
    expect(reply.frictionCount).toBe(2);
  });

  it('refuses an unknown or malformed persona id readably', async () => {
    const files = seeded();
    const service = serviceOf(files);
    const ghost = await service.personaImprovements('ghost');
    expect(ghost).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
    const malformed = await service.personaImprovements('Pia');
    expect(malformed).toMatchObject({ ok: false, error: expect.stringContaining('lowercase letters, digits and dashes') });
  });
});

describe('improvementInput (E6 read)', () => {
  const run = (partial: Partial<RunInfo>): RunInfo =>
    ({
      id: 'r1',
      ticketId: 'T-0001',
      persona: 'pia',
      state: 'done',
      startedAt: '2026-11-02T09:00:00Z',
      endedAt: '2026-11-02T09:30:00Z',
      ...partial,
    }) as unknown as RunInfo;

  it('carries the friction, the last aggregation and the persona-filtered run count', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: '2026-11-02T08:00:00Z', proposals: [] }),
    );
    const runs = [
      run({ id: 'r-new', startedAt: '2026-11-02T09:00:00Z' }), // after the aggregation — counts
      run({ id: 'r-old', startedAt: '2026-10-30T09:00:00Z' }), // before it — does not
      run({ id: 'r-ben', persona: 'ben', startedAt: '2026-11-02T09:30:00Z' }), // another persona
      run({ id: 'r-none', persona: null, startedAt: '2026-11-02T09:45:00Z' }), // pre-personas record
    ];
    const input = await serviceOf(files, runs).improvementInput('pia');
    expect(input.lastAggregation).toBe('2026-11-02T08:00:00Z');
    expect(input.settledRuns).toBe(1);
    expect(input.friction).toEqual(parseFriction(files.get('tickets/_meta/personas/pia/friction.md')!));
  });

  it('reads 0 settled runs when never aggregated, and an empty input for an unknown persona', async () => {
    const files = seeded();
    const input = await serviceOf(files, [run({})]).improvementInput('pia');
    expect(input).toEqual({ friction: parseFriction(files.get('tickets/_meta/personas/pia/friction.md')!), lastAggregation: null, settledRuns: 0 });
    expect(await serviceOf(files).improvementInput('ghost')).toEqual({ friction: [], lastAggregation: null, settledRuns: 0 });
  });
});

describe('applyAggregation (E6 write)', () => {
  it('mints imp-<n> ids, stamps the aggregation, truncates friction.md to its heading', async () => {
    const files = seeded();
    const service = serviceOf(files);
    const result = await service.applyAggregation({ id: 'pia', drafts: DRAFTS, now: '2026-11-02T10:00:00Z' });
    expect(result).toEqual({ ok: true, warning: 'the tickets vault is not a git repository — the change is not versioned' });

    const file = parseImprovements(files.get('tickets/_meta/personas/pia/improvements.md')!);
    expect(file.lastAggregation).toBe('2026-11-02T10:00:00Z');
    expect(file.proposals.map((p) => `${p.id} ${p.state} ${p.target}`)).toEqual(['imp-1 open prompt.md', 'imp-2 open memory']);
    expect(file.proposals[0]).toMatchObject({ title: 'Order the context pack by name', evidence: DRAFTS[0]!.evidence, content: 'Read the pack first.', lesson: 'Keep the pack recipe explicit.', at: '2026-11-02T10:00:00Z', decidedAt: null });
    expect(file.proposals[1]!.content).toBe('Check the ledger\nbefore dispatch.');

    // The findings moved into the evidence — only the heading stays.
    expect(files.get('tickets/_meta/personas/pia/friction.md')).toBe('# Friction\n');

    // The next aggregation mints from the file: ids are never reused.
    await service.applyAggregation({ id: 'pia', drafts: [DRAFTS[0]!], now: '2026-11-03T10:00:00Z' });
    const grown = parseImprovements(files.get('tickets/_meta/personas/pia/improvements.md')!);
    expect(grown.lastAggregation).toBe('2026-11-03T10:00:00Z');
    expect(grown.proposals.map((p) => p.id)).toEqual(['imp-1', 'imp-2', 'imp-3']);
  });

  it('refuses an unknown persona and no-ops on an empty draft list', async () => {
    const files = seeded();
    const service = serviceOf(files);
    const ghost = await service.applyAggregation({ id: 'ghost', drafts: DRAFTS, now: '2026-11-02T10:00:00Z' });
    expect(ghost).toMatchObject({ ok: false, error: expect.stringContaining('does not exist') });
    expect(files.has('tickets/_meta/personas/pia/improvements.md')).toBe(false);

    expect(await service.applyAggregation({ id: 'pia', drafts: [], now: '2026-11-02T10:00:00Z' })).toEqual({ ok: true });
    expect(files.has('tickets/_meta/personas/pia/improvements.md')).toBe(false);
    expect(files.get('tickets/_meta/personas/pia/friction.md')).toContain('guessed the order.md shape');
  });
});

describe('decideImprovement (E6 write)', () => {
  it('applying a prompt.md proposal rewrites prompt.md, marks the decision and always appends the lesson', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: '2026-11-02T10:00:00Z', proposals: [proposal({ id: 'imp-1', content: 'The new prompt.', lesson: 'Keep the pack recipe explicit.' })] }),
    );
    const result = await serviceOf(files).decideImprovement({ id: 'pia', proposalId: 'imp-1', decision: 'accepted', now: '2026-11-02T11:00:00Z' });
    expect(result.ok).toBe(true);

    expect(files.get('tickets/_meta/personas/pia/prompt.md')).toBe('The new prompt.');
    const file = parseImprovements(files.get('tickets/_meta/personas/pia/improvements.md')!);
    expect(file.proposals[0]).toMatchObject({ id: 'imp-1', state: 'accepted', decidedAt: '2026-11-02T11:00:00Z' });
    expect(file.lastAggregation).toBe('2026-11-02T10:00:00Z'); // the decision does not move the stamp

    // The lesson lands in memory.md even though the target was prompt.md.
    expect(files.get('tickets/_meta/personas/pia/memory.md')).toBe('# Memory\n\n- Keep the pack recipe explicit.\n');
  });

  it('applying a models.default proposal patches only the frontmatter key — pool, comments and body survive', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: null, proposals: [proposal({ id: 'imp-4', target: 'models.default', title: 'Try sonnet', content: 'sonnet' })] }),
    );
    const result = await serviceOf(files).decideImprovement({ id: 'pia', proposalId: 'imp-4', decision: 'accepted', now: '2026-11-02T12:00:00Z' });
    expect(result.ok).toBe(true);

    const persona = files.get('tickets/_meta/personas/pia/persona.md')!;
    expect(persona).toContain('default: sonnet # the everyday model'); // the comment stays on the line
    expect(persona).toContain('pool: [opus, sonnet]');
    expect(persona).toContain('router: off');
    expect(persona).toContain('color: \'#a78bfa\'');
    expect(persona).toContain('Who Pia is.');
    expect(persona).not.toContain('default: opus\n');
  });

  it('applying a memory proposal appends the content as one line (header on creation)', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: null, proposals: [proposal({ id: 'imp-2', target: 'memory', title: 'Remember', content: 'Check the ledger\nbefore dispatch.', lesson: 'Ledger first.' })] }),
    );
    const result = await serviceOf(files).decideImprovement({ id: 'pia', proposalId: 'imp-2', decision: 'accepted', now: '2026-11-02T12:00:00Z' });
    expect(result.ok).toBe(true);

    // The content is one memory line; the non-null lesson follows as a second.
    expect(files.get('tickets/_meta/personas/pia/memory.md')).toBe(
      '# Memory\n\n- Check the ledger before dispatch.\n- Ledger first.\n',
    );
  });

  it('dismissing applies nothing but still records the lesson and the decision', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: null, proposals: [proposal({ id: 'imp-3', content: 'Would-have-been prompt.', lesson: 'Do it by hand instead.' })] }),
    );
    const result = await serviceOf(files).decideImprovement({ id: 'pia', proposalId: 'imp-3', decision: 'dismissed', now: '2026-11-02T12:00:00Z' });
    expect(result.ok).toBe(true);

    expect(files.get('tickets/_meta/personas/pia/prompt.md')).toBe('The old prompt.\n'); // untouched
    const file = parseImprovements(files.get('tickets/_meta/personas/pia/improvements.md')!);
    expect(file.proposals[0]).toMatchObject({ state: 'dismissed', decidedAt: '2026-11-02T12:00:00Z' });
    expect(files.get('tickets/_meta/personas/pia/memory.md')).toBe('# Memory\n\n- Do it by hand instead.\n');
  });

  it('refuses unknown and already-decided proposals readably', async () => {
    const files = seeded();
    files.set(
      'tickets/_meta/personas/pia/improvements.md',
      renderImprovements('pia', { lastAggregation: null, proposals: [proposal({ id: 'imp-1', state: 'accepted', decidedAt: '2026-11-02T11:00:00Z' })] }),
    );
    const service = serviceOf(files);
    const unknown = await service.decideImprovement({ id: 'pia', proposalId: 'imp-9', decision: 'dismissed' });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('imp-9 is not one of pia') });
    const closed = await service.decideImprovement({ id: 'pia', proposalId: 'imp-1', decision: 'dismissed' });
    expect(closed).toMatchObject({ ok: false, error: expect.stringContaining('imp-1 is already accepted') });
  });
});
