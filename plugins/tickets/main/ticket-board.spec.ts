import { describe, expect, it } from 'vitest';
import {
  applyColumnsToPipeline,
  assembleBoard,
  dropOrderSections,
  orderAfterInsert,
  orderColumn,
  parseOrderFile,
  parsePipeline,
  parseRepos,
  pinsAfterDrop,
  rewriteOrderSection,
  validateColumnsBatch,
} from './ticket-board';
import type { ColumnsBatch, PipelinePhase } from '../shared/tickets';

const PIPELINE = `---
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, wip: 2, claim: true, handover: agent build-default }
  - { id: done, title: Done, handover: none }
---
Prose.
`;

describe('parsePipeline', () => {
  it('reads the default shape with wip/claim/handover', () => {
    const { phases, error } = parsePipeline(PIPELINE);
    expect(error).toBeNull();
    expect(phases.map((p) => p.id)).toEqual(['inbox', 'prioritized', 'build', 'done']);
    expect(phases[2]!.wip).toBe(2);
    expect(phases[2]!.claim).toBe(true);
    expect(phases[2]!.handover).toBe('agent build-default');
    expect(phases[0]!.title).toBe('Inbox');
  });

  it('reads the optional push: remote (T-0041)', () => {
    const withPush = PIPELINE.replace(/^---/, "---\npush: origin");
    const parsed = parsePipeline(withPush);
    expect(parsed.pushRemote).toBe('origin');
    expect(parsed.issues).toEqual([]);
    expect(parsePipeline(PIPELINE).pushRemote).toBeNull();
  });

  it('a non-string push: degrades to null with a noise finding', () => {
    const parsed = parsePipeline(PIPELINE.replace(/^---/, '---\npush: [upstream, 42]'));
    expect(parsed.pushRemote).toBeNull();
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]!.level).toBe('noise');
    expect(parsed.issues[0]!.message).toContain('push');
  });

  it('refuses empty lists, duplicate ids and bad id grammar', () => {
    expect(parsePipeline('---\nphases: []\n---\n').error).toContain('non-empty');
    const dup = '---\nphases:\n  - { id: inbox }\n  - { id: inbox }\n---\n';
    expect(parsePipeline(dup).error).toContain('duplicate');
    const bad = '---\nphases:\n  - { id: "1bad" }\n---\n';
    expect(parsePipeline(bad).error).toContain('phase id');
  });

  it('refuses broken YAML and missing fences', () => {
    expect(parsePipeline('no fence').error).toContain('fence');
    expect(parsePipeline('---\nphases: [\n---\n').error).toContain('parse');
  });
});

describe('order files', () => {
  it('parses sparse sections and flags noise', () => {
    const text = '# pins\n\n## prioritized\n\n- T-0002\n- T-0001\n\n## Not A Phase\n\n- T-0003\n';
    const { pins, issues } = parseOrderFile(text);
    expect(pins['prioritized']).toEqual(['T-0002', 'T-0001']);
    expect(issues.length).toBe(1);
    expect(issues[0]!.level).toBe('noise');
  });

  it('rewrites one section in place and preserves the rest', () => {
    const text = '# pins\n\n## prioritized\n\n- T-0002\n- T-0001\n\n## build\n\n- T-0005\n';
    const next = rewriteOrderSection(text, 'prioritized', ['T-0001', 'T-0009']);
    expect(next).toContain('## prioritized');
    const { pins } = parseOrderFile(next);
    expect(pins['prioritized']).toEqual(['T-0001', 'T-0009']);
    expect(pins['build']).toEqual(['T-0005']);
  });

  it('appends a missing section and trims trailing blanks', () => {
    const next = rewriteOrderSection('# pins\n', 'build', ['T-0002']);
    expect(parseOrderFile(next).pins['build']).toEqual(['T-0002']);
  });

  it('null reads parse to no pins', () => {
    expect(parseOrderFile(null).pins).toEqual({});
  });
});

describe('parseRepos', () => {
  it('reads the mapping with optional branch, policy and local path', () => {
    const text = [
      '---',
      'repos:',
      '  drey:',
      '    url: https://github.com/x/Drey.git',
      '    branch: main',
      '    path: E:/projects/Drey-m83',
      '  local:',
      '    url: E:/code/local',
      '---',
    ].join('\n');
    const { repos, error } = parseRepos(text);
    expect(error).toBeNull();
    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({
      name: 'drey',
      url: 'https://github.com/x/Drey.git',
      branch: 'main',
      policy: null,
      path: 'E:/projects/Drey-m83',
    });
    expect(repos[1]).toMatchObject({ name: 'local', url: 'E:/code/local', branch: null, path: null });
  });

  it('requires a url per repo and a repos mapping', () => {
    const noUrl = '---\nrepos:\n  x:\n    branch: main\n---\n';
    expect(parseRepos(noUrl).error).toContain('needs a url');
    expect(parseRepos('---\nrepos: 3\n---\n').error).toContain('mapping');
    expect(parseRepos(null).repos).toEqual([]);
  });
});

describe('ordering', () => {
  const ticket = (
    id: string,
    priority: 'urgent' | 'high' | 'normal' | 'low',
    rank: number,
    entered: string,
  ) => ({
    id,
    priority,
    rank,
    entered,
    key: { id, priority, rank, entered },
  });

  it('derives: priority, then rank, then entered, then id', () => {
    const tickets = [
      ticket('T-0003', 'normal', 5000, '2026-10-17T10:00:00Z'),
      ticket('T-0001', 'urgent', 9000, '2026-10-17T12:00:00Z'),
      ticket('T-0002', 'urgent', 1000, '2026-10-17T11:00:00Z'),
      ticket('T-0004', 'normal', 5000, '2026-10-16T09:00:00Z'),
      ticket('T-0005', 'normal', 5000, ''),
    ];
    const ordered = orderColumn(tickets, undefined, (t) => t.key);
    expect(ordered.map((t) => t.id)).toEqual(['T-0002', 'T-0001', 'T-0004', 'T-0003', 'T-0005']);
  });

  it('pins first in listed order, then derived ??? unknown pins ignored', () => {
    const tickets = [
      ticket('T-0001', 'urgent', 5000, ''),
      ticket('T-0002', 'normal', 5000, ''),
      ticket('T-0003', 'normal', 5000, ''),
    ];
    const ordered = orderColumn(tickets, ['T-0009', 'T-0002'], (t) => t.key);
    expect(ordered.map((t) => t.id)).toEqual(['T-0002', 'T-0001', 'T-0003']);
  });

  it('a drag pins everything above and including the drop', () => {
    expect(pinsAfterDrop(['a', 'b', 'c', 'd'], 0)).toEqual(['a']);
    expect(pinsAfterDrop(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b', 'c']);
    expect(pinsAfterDrop(['a', 'b', 'c', 'd'], 9)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('insertion removes a prior position and clamps', () => {
    expect(orderAfterInsert(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(orderAfterInsert(['a', 'b'], 'x', 9)).toEqual(['a', 'b', 'x']);
  });
});

describe('assembleBoard', () => {
  const ticketText = (id: string, title: string, extra = ''): string =>
    [
      '---',
      `id: ${id}`,
      `title: "${title}"`,
      'repo: drey',
      'priority: normal',
      'rank: 5000',
      `branch: t/${id}`,
      `entered-inbox: '2026-10-17T09:00:00Z'`,
      extra,
      '---',
      '',
      '## Description',
      '',
      title,
      '',
      '## Log',
      '',
      `- '2026-10-17T09:00:00Z' owner@desk ??? created in inbox`,
      '',
    ].join('\n');

  const baseInput = (files: { path: string; text: string }[], orderText: string | null = null) => ({
    vaultId: 'v1',
    vaultName: 'tickets',
    activeVaultName: 'tickets',
    isGitRepo: true,
    defaultWorker: 'opencode',
    pipelineText: PIPELINE,
    orderText,
    reposText: '---\nrepos:\n  drey:\n    url: https://example/drey.git\n---\n',
    files,
  });

  it('builds configured columns in pipeline order with tickets placed', () => {
    const snap = assembleBoard(baseInput([
      { path: 'tickets/inbox/T-0002.md', text: ticketText('T-0002', 'Second') },
      { path: 'tickets/build/T-0001.md', text: ticketText('T-0001', 'First') },
    ]));
    expect(snap.columns.map((c) => c.phase.id)).toEqual(['inbox', 'prioritized', 'build', 'done']);
    expect(snap.columns[0]!.tickets.map((t) => t.id)).toEqual(['T-0002']);
    expect(snap.columns[2]!.tickets.map((t) => t.id)).toEqual(['T-0001']);
    expect(snap.issues).toEqual([]);
  });

  it('folds numbered phase directories into the stripped phase columns (T-0041)', () => {
    const snap = assembleBoard(baseInput([
      { path: 'tickets/10-inbox/T-0002.md', text: ticketText('T-0002', 'Second') },
      { path: 'tickets/35-qa/T-0001.md', text: ticketText('T-0001', 'Gap column') },
      { path: 'tickets/inbox/T-0003.md', text: ticketText('T-0003', 'Unprefixed') },
    ]));
    // Configured columns first (pipeline order), numbered and unprefixed
    // inbox files folded into ONE inbox column.
    expect(snap.columns.slice(0, 4).map((c) => c.phase.id)).toEqual(['inbox', 'prioritized', 'build', 'done']);
    expect(snap.columns[0]!.tickets.map((t) => t.id)).toEqual(['T-0002', 'T-0003']);
    // 35-qa is not a pipeline phase here: it lands in the trailing unknown
    // column under its STRIPPED id (reader-forgiving, never renumbered).
    const unknown = snap.columns[snap.columns.length - 1]!;
    expect(unknown.unknown).toBe(true);
    expect(unknown.phase.id).toBe('qa');
    // The card keeps its real on-disk path.
    expect(snap.columns[0]!.tickets[0]!.path).toBe('tickets/10-inbox/T-0002.md');
  });

  it('threads the pipeline push: remote into the snapshot (T-0041)', () => {
    const withPush = PIPELINE.replace(/^---/, '---\npush: origin');
    const snap = assembleBoard({ ...baseInput([]), pipelineText: withPush });
    expect(snap.pushRemote).toBe('origin');
    expect(assembleBoard(baseInput([])).pushRemote).toBeNull();
  });

  it('carries promptRefs into the snapshot, defaulting to none (T-0043)', () => {
    const snap = assembleBoard({ ...baseInput([]), promptRefs: ['build-default', 'plan-heavy'] });
    expect(snap.promptRefs).toEqual(['build-default', 'plan-heavy']);
    expect(assembleBoard(baseInput([])).promptRefs).toEqual([]);
  });

  it('carries an unknown phase directory as a trailing unknown column', () => {
    const snap = assembleBoard(baseInput([
      { path: 'tickets/inbox/T-0002.md', text: ticketText('T-0002', 'Second') },
      { path: 'tickets/limbo/T-0001.md', text: ticketText('T-0001', 'Lost phase') },
    ]));
    const last = snap.columns[snap.columns.length - 1]!;
    expect(last.unknown).toBe(true);
    expect(last.phase.id).toBe('limbo');
    expect(snap.issues.some((i) => i.message.includes('limbo'))).toBe(true);
  });

  it('flags duplicate ids across phases and stray files', () => {
    const snap = assembleBoard(baseInput([
      { path: 'tickets/inbox/T-0001.md', text: ticketText('T-0001', 'One') },
      { path: 'tickets/build/T-0001.md', text: ticketText('T-0001', 'Twin') },
      { path: 'tickets/inbox/readme.md', text: 'note' },
    ]));
    const twin = snap.columns.flatMap((c) => c.tickets).filter((t) => t.id === 'T-0001');
    expect(twin).toHaveLength(2);
    expect(twin.every((t) => t.issues.some((i) => i.message.includes('more than one phase')))).toBe(true);
    expect(snap.issues.some((i) => i.message.includes('unexpected file'))).toBe(true);
  });

  it('never badges _meta files as strays, even when fed unfiltered', () => {
    const base = baseInput([{ path: 'tickets/inbox/T-0001.md', text: ticketText('T-0001', 'One') }]);
    const snap = assembleBoard({
      ...base,
      defaultWorker: 'opencode',
      files: [
        ...base.files,
        { path: 'tickets/_meta/pipeline.md', text: 'x' },
        { path: 'tickets/_meta/T-0099.md', text: ticketText('T-0099', 'Hidden') },
      ],
    });
    expect(snap.issues.filter((i) => i.message.includes('unexpected file'))).toEqual([]);
    expect(snap.columns.flatMap((c) => c.tickets).some((t) => t.id === 'T-0099')).toBe(false);
  });

  it('excludes tickets/archive/ entirely — no column, no badge, no count (T-0041)', () => {
    const snap = assembleBoard(baseInput([
      { path: 'tickets/inbox/T-0001.md', text: ticketText('T-0001', 'One') },
      { path: 'tickets/archive/T-0002.md', text: ticketText('T-0002', 'Gone but kept') },
    ]));
    expect(snap.columns.flatMap((c) => c.tickets).some((t) => t.id === 'T-0002')).toBe(false);
    expect(snap.issues.some((i) => i.message.includes('T-0002'))).toBe(false);
    expect(snap.issues.some((i) => i.message.includes('archive'))).toBe(false);
    // A pipeline phase named "archive" is not fed from the reserved folder.
    expect(snap.columns.some((c) => c.phase.id === 'archive')).toBe(false);
  });

  it('applies pins as the column top and marks cards pinned', () => {
    const snap = assembleBoard(
      baseInput(
        [
          { path: 'tickets/inbox/T-0001.md', text: ticketText('T-0001', 'One', "entered-inbox: '2026-10-17T08:00:00Z'") },
          { path: 'tickets/inbox/T-0002.md', text: ticketText('T-0002', 'Two') },
        ],
        '# pins\n\n## inbox\n\n- T-0002\n- T-0001\n',
      ),
    );
    const inbox = snap.columns[0]!;
    expect(inbox.tickets.map((t) => t.id)).toEqual(['T-0002', 'T-0001']);
    expect(inbox.tickets[0]!.pinned).toBe(true);
    expect(inbox.tickets[1]!.pinned).toBe(true);
  });

  it('warns when a ticket names an unknown repo', () => {
    const text = ticketText('T-0003', 'Elsewhere').replace('repo: drey', 'repo: nowhere');
    const snap = assembleBoard(baseInput([{ path: 'tickets/inbox/T-0003.md', text }]));
    expect(snap.columns[0]!.tickets[0]!.issues.some((i) => i.message.includes('nowhere'))).toBe(true);
  });

  it('renders the no-vault snapshot when the pipeline is missing', () => {
    const snap = assembleBoard({ ...baseInput([]), vaultId: null, vaultName: null, pipelineText: null });
    expect(snap.vaultId).toBeNull();
    expect(snap.pipelineError).toContain('missing');
    expect(snap.columns).toEqual([]);
  });
});

describe('applyColumnsToPipeline - the store-on-leave writer (T-0043)', () => {
  const batchOf = (parts: Partial<ColumnsBatch>): ColumnsBatch => ({
    order: ['inbox', 'prioritized', 'build', 'done'],
    add: [],
    remove: [],
    patch: {},
    ...parts,
  });

  it('setting a worker writes the agent handover and keeps the file shape', () => {
    const patched = applyColumnsToPipeline(
      PIPELINE,
      batchOf({ patch: { prioritized: { worker: 'opencode' } } }),
    );
    const { phases, error } = parsePipeline(patched);
    expect(error).toBeNull();
    const prioritized = phases.find((p) => p.id === 'prioritized')!;
    expect(prioritized.worker).toBe('opencode');
    expect(prioritized.handover).toBe('agent prioritized-default');
    // Everything else survives untouched.
    expect(patched).toContain('wip: 2, claim: true');
    expect(patched).toContain('Prose.');
    expect(parsePipeline(patched).phases.find((p) => p.id === 'inbox')!.handover).toBe('manual');
  });

  it('an explicit prompt rides the new handover; an existing ref is kept', () => {
    const withPrompt = applyColumnsToPipeline(
      PIPELINE,
      batchOf({ patch: { prioritized: { worker: 'opencode', prompt: 'plan-heavy' } } }),
    );
    expect(parsePipeline(withPrompt).phases.find((p) => p.id === 'prioritized')!.handover).toBe(
      'agent plan-heavy',
    );
    const kept = applyColumnsToPipeline(PIPELINE, batchOf({ patch: { build: { worker: 'claude-code' } } }));
    expect(parsePipeline(kept).phases.find((p) => p.id === 'build')!.handover).toBe('agent build-default');
  });

  it('clearing the worker writes manual and takes the pool keys with it', () => {
    const withPool = applyColumnsToPipeline(
      PIPELINE,
      batchOf({ patch: { build: { model: 'zai/glm-5.3', workers: 4 } } }),
    );
    const cleared = applyColumnsToPipeline(withPool, batchOf({ patch: { build: { worker: null } } }));
    const build = parsePipeline(cleared).phases.find((p) => p.id === 'build')!;
    expect(build.handover).toBe('manual');
    expect(build.worker).toBeNull();
    expect(build.model).toBeNull();
    expect(build.workers).toBe(1);
    expect(build.claim).toBe(true); // claim and wip survive the manual flip
    expect(build.wip).toBe(2);
  });

  it('model, workers and prompt patch independently; unknown phases refuse', () => {
    const patched = applyColumnsToPipeline(
      PIPELINE,
      batchOf({ patch: { build: { workers: 4, model: 'zai/glm-5.3-flash' } } }),
    );
    const build = parsePipeline(patched).phases.find((p) => p.id === 'build')!;
    expect(build.workers).toBe(4);
    expect(build.model).toBe('zai/glm-5.3-flash');
    expect(() => applyColumnsToPipeline(PIPELINE, batchOf({ patch: { nope: { workers: 2 } } }))).toThrow(
      'no phase "nope"',
    );
    expect(() => applyColumnsToPipeline(PIPELINE, batchOf({ patch: { build: { workers: 0 } } }))).toThrow(
      'whole number',
    );
  });

  it('moves whole entries and keeps every key and the prose', () => {
    const swapped = applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'build', 'prioritized', 'done'] }));
    const { phases, error } = parsePipeline(swapped);
    expect(error).toBeNull();
    expect(phases.map((p) => p.id)).toEqual(['inbox', 'build', 'prioritized', 'done']);
    expect(phases[1]!.wip).toBe(2);
    expect(phases[1]!.handover).toBe('agent build-default');
    expect(swapped).toContain('Prose.');
  });

  it('refuses an order that drops, repeats or invents a phase, or moves the ends', () => {
    expect(() => applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'build', 'done'] }))).toThrow(
      'exactly once',
    );
    expect(() =>
      applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'build', 'build', 'done'] })),
    ).toThrow('exactly once');
    expect(() =>
      applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'qa', 'prioritized', 'done'] })),
    ).toThrow('exactly once');
    expect(() =>
      applyColumnsToPipeline(PIPELINE, batchOf({ order: ['prioritized', 'inbox', 'build', 'done'] })),
    ).toThrow('keep their places');
    expect(() =>
      applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'prioritized', 'done', 'build'] })),
    ).toThrow('keep their places');
  });

  it('splices an added column at its order position, manual, before the terminal', () => {
    const withQa = applyColumnsToPipeline(
      PIPELINE,
      batchOf({
        order: ['inbox', 'prioritized', 'build', 'qa', 'done'],
        add: [{ id: 'qa', title: 'QA' }],
      }),
    );
    const { phases, error } = parsePipeline(withQa);
    expect(error).toBeNull();
    expect(phases.map((p) => p.id)).toEqual(['inbox', 'prioritized', 'build', 'qa', 'done']);
    const qa = phases.find((p) => p.id === 'qa')!;
    expect(qa.title).toBe('QA');
    expect(qa.handover).toBe('manual');
    expect(withQa).toContain('Prose.');
    // Setting a worker on the fresh column in the same session works
    // (one batch: the add and the patch ride together).
    const staffed = applyColumnsToPipeline(
      PIPELINE,
      batchOf({
        order: ['inbox', 'prioritized', 'build', 'qa', 'done'],
        add: [{ id: 'qa', title: 'QA' }],
        patch: { qa: { worker: 'opencode', workers: 2 } },
      }),
    );
    const staffedQa = parsePipeline(staffed).phases.find((p) => p.id === 'qa')!;
    expect(staffedQa.handover).toBe('agent qa-default');
    expect(staffedQa.worker).toBe('opencode');
    expect(staffedQa.workers).toBe(2);
  });

  it('deletes a removed entry and applies a patch in the same pass', () => {
    const result = applyColumnsToPipeline(
      PIPELINE,
      batchOf({
        order: ['inbox', 'build', 'done'],
        remove: ['prioritized'],
        patch: { build: { workers: 3 } },
      }),
    );
    const { phases, error } = parsePipeline(result);
    expect(error).toBeNull();
    expect(phases.map((p) => p.id)).toEqual(['inbox', 'build', 'done']);
    expect(phases.find((p) => p.id === 'build')!.workers).toBe(3);
    expect(() =>
      applyColumnsToPipeline(PIPELINE, batchOf({ order: ['inbox', 'build', 'done'], remove: ['nope'] })),
    ).toThrow('no phase "nope"');
  });

  it('keeps unknown phase keys, comments and the hand-made layout (document mutation)', () => {
    const loaded = [
      '---',
      'push: origin',
      '# the pipeline',
      'phases:',
      '  # capture',
      '  - { id: inbox, title: Inbox, handover: manual }',
      '  - id: build',
      '    title: Build',
      '    wip: 2',
      '    claim: true',
      '    handover: agent build-default',
      '    worker: opencode',
      '    model: zai/glm-5.3',
      '    max-red: 5',
      '    token-budget: 250000',
      '    ci: npm test',
      '    audit: 0.25',
      '    semantic: true',
      '  - { id: done, title: Done, handover: none }',
      '---',
      'Prose.',
    ].join('\n');
    const patched = applyColumnsToPipeline(
      loaded,
      batchOf({
        order: ['inbox', 'qa', 'build', 'done'],
        add: [{ id: 'qa', title: 'QA' }],
        patch: { build: { workers: 2 } },
      }),
    );
    expect(patched).toContain('# the pipeline');
    expect(patched).toContain('# capture');
    expect(patched).toContain('max-red: 5');
    expect(patched).toContain('token-budget: 250000');
    expect(patched).toContain('ci: npm test');
    expect(patched).toContain('audit: 0.25');
    expect(patched).toContain('semantic: true');
    expect(patched).toContain('push: origin');
    const { phases, error } = parsePipeline(patched);
    expect(error).toBeNull();
    const build = phases.find((p) => p.id === 'build')!;
    expect(build.workers).toBe(2);
    expect(build.maxRed).toBe(5);
    expect(build.ci).toBe('npm test');
    expect(build.semantic).toBe(true);
  });
});

describe('validateColumnsBatch - the authoritative refusal (T-0043)', () => {
  const phases = (ids: readonly string[]): PipelinePhase[] =>
    ids.map(
      (id) =>
        ({
          id,
          title: id,
          wip: null,
          claim: false,
          handover: 'manual',
          worker: null,
          model: null,
          workers: 1,
          prompt: null,
          maxRed: null,
          tokenBudget: null,
          ci: null,
          audit: null,
          semantic: false,
        }) as PipelinePhase,
    );
  const current = phases(['inbox', 'prioritized', 'build', 'review', 'done']);
  const batchOf = (parts: Partial<ColumnsBatch>): ColumnsBatch => ({
    order: current.map((p) => p.id),
    add: [],
    remove: [],
    patch: {},
    ...parts,
  });

  it('accepts a well-formed batch (null)', () => {
    expect(
      validateColumnsBatch(current, batchOf({ order: ['inbox', 'build', 'prioritized', 'review', 'done'] }), {
        build: 2,
      }),
    ).toBeNull();
    expect(
      validateColumnsBatch(
        current,
        batchOf({
          order: ['inbox', 'build', 'review', 'done'],
          remove: ['prioritized'],
          patch: { build: { worker: 'opencode', workers: 3, model: 'zai/glm-5.3', prompt: 'plan-heavy' } },
        }),
        { build: 2 },
      ),
    ).toBeNull();
  });

  it('refuses a wrong order, wrong ends and invented or repeated ids', () => {
    expect(
      validateColumnsBatch(current, batchOf({ order: ['inbox', 'build', 'review', 'done'] }), {}),
    ).toContain('exactly once');
    expect(
      validateColumnsBatch(current, batchOf({ order: ['inbox', 'build', 'build', 'review', 'done'] }), {}),
    ).toContain('exactly once');
    expect(
      validateColumnsBatch(current, batchOf({ order: ['prioritized', 'inbox', 'build', 'review', 'done'] }), {}),
    ).toContain('keep their places');
    expect(
      validateColumnsBatch(current, batchOf({ order: ['inbox', 'prioritized', 'build', 'done', 'review'] }), {}),
    ).toContain('keep their places');
    expect(validateColumnsBatch([], batchOf({ order: [] }), {})).toContain('pipeline is empty');
  });

  it('refuses added ids that break the grammar or collide', () => {
    const order = ['inbox', 'prioritized', 'build', 'review', 'qa', 'done'];
    expect(
      validateColumnsBatch(
        current,
        batchOf({ order: ['inbox', 'prioritized', 'build', 'review', '1qa', 'done'], add: [{ id: '1qa', title: 'QA' }] }),
        {},
      ),
    ).toContain('must match');
    expect(
      validateColumnsBatch(current, batchOf({ order: [...current.map((p) => p.id), 'build'], add: [] }), {}),
    ).toContain('exactly once');
    expect(
      validateColumnsBatch(current, batchOf({ order, add: [{ id: 'qa', title: '' }] }), {}),
    ).toContain('title');
    // Two adds of one id collide with each other.
    expect(
      validateColumnsBatch(
        current,
        batchOf({ order: ['inbox', 'prioritized', 'build', 'review', 'qa', 'qa2', 'done'], add: [{ id: 'qa', title: 'QA' }, { id: 'qa', title: 'QA' }] }),
        {},
      ),
    ).toContain('already exists');
    // A pipeline of one phase has no before-terminal slot.
    expect(
      validateColumnsBatch(
        phases(['inbox']),
        {
          order: ['inbox', 'qa'],
          add: [{ id: 'qa', title: 'QA' }],
          remove: [],
          patch: {},
        },
        {},
      ),
    ).toContain('first and a last column');
  });

  it('refuses removing the first, the last, an unknown or a holding column', () => {
    expect(
      validateColumnsBatch(current, batchOf({ order: ['prioritized', 'build', 'review', 'done'], remove: ['inbox'] }), {}),
    ).toContain('first column');
    expect(
      validateColumnsBatch(current, batchOf({ order: ['inbox', 'prioritized', 'build', 'review'], remove: ['done'] }), {}),
    ).toContain('last column');
    expect(
      validateColumnsBatch(current, batchOf({ remove: ['nope'] }), {}),
    ).toContain('not in the pipeline');
    expect(
      validateColumnsBatch(
        current,
        batchOf({ order: ['inbox', 'build', 'review', 'done'], remove: ['prioritized'] }),
        { prioritized: 3 },
      ),
    ).toBe('"prioritized" still holds 3 tickets — move or archive them first');
    expect(
      validateColumnsBatch(
        current,
        batchOf({ order: ['inbox', 'build', 'review', 'done'], remove: ['prioritized'] }),
        { prioritized: 1 },
      ),
    ).toBe('"prioritized" still holds 1 ticket — move or archive it first');
  });

  it('refuses ill-formed patch values and patches of foreign columns', () => {
    expect(validateColumnsBatch(current, batchOf({ patch: { build: { worker: 'github' } } }), {})).toContain(
      'the worker is',
    );
    expect(validateColumnsBatch(current, batchOf({ patch: { build: { workers: 1.5 } } }), {})).toContain(
      'whole number',
    );
    expect(validateColumnsBatch(current, batchOf({ patch: { build: { workers: 0 } } }), {})).toContain(
      'whole number',
    );
    expect(
      validateColumnsBatch(
        current,
        batchOf({ order: ['inbox', 'build', 'review', 'done'], remove: ['prioritized'], patch: { prioritized: { workers: 2 } } }),
        {},
      ),
    ).toContain('not a column of this batch');
    expect(validateColumnsBatch(current, batchOf({ patch: { nope: { workers: 2 } } }), {})).toContain(
      'not a column of this batch',
    );
  });
});

describe('dropOrderSections (T-0043)', () => {
  const TEXT = '# pins\n\n## prioritized\n\n- T-0002\n- T-0001\n\n## build\n\n- T-0005\n';

  it('drops the named sections and keeps the rest verbatim', () => {
    const next = dropOrderSections(TEXT, ['build']);
    expect(parseOrderFile(next).pins).toEqual({ prioritized: ['T-0002', 'T-0001'] });
    expect(next).toContain('# pins');
    expect(next).not.toContain('T-0005');
  });

  it('drops several sections, including a trailing one', () => {
    const next = dropOrderSections(TEXT, ['prioritized', 'build']);
    expect(parseOrderFile(next).pins).toEqual({});
    expect(next).toBe('# pins\n');
  });

  it('is null for a null text, no ids or nothing matched (no write)', () => {
    expect(dropOrderSections(null, ['build'])).toBeNull();
    expect(dropOrderSections(TEXT, [])).toBeNull();
    expect(dropOrderSections(TEXT, ['qa'])).toBeNull();
  });
});
