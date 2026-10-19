import { describe, expect, it } from 'vitest';
import type { PipelinePhase } from '../shared/tickets';
import { detectDrift, parseArchivedStamp, type DriftFile } from './normalize';

const PIPELINE: readonly PipelinePhase[] = [
  { id: 'inbox', title: 'Inbox', wip: null, claim: false, handover: 'manual' },
  { id: 'prioritized', title: 'Prioritized', wip: null, claim: false, handover: 'manual' },
  { id: 'plan', title: 'Plan', wip: 1, claim: false, handover: 'manual' },
  { id: 'build', title: 'Build', wip: 3, claim: true, handover: 'agent build-default' },
  { id: 'done', title: 'Done', wip: null, claim: false, handover: 'none' },
];

/** A ticket file with the given entered stamps and optional Log lines. */
function ticketFile(entries: {
  entered?: Record<string, string>;
  log?: string[];
  extra?: string;
}): string {
  const stamps = Object.entries(entries.entered ?? {})
    .map(([phase, stamp]) => `entered-${phase}: '${stamp}'`)
    .join('\n');
  return [
    '---',
    "id: T-0001",
    'title: "Drift"',
    'repo: drey',
    'priority: normal',
    'rank: 5000',
    'branch: t/T-0001',
    ...(stamps === '' ? [] : [stamps]),
    ...(entries.extra === undefined ? [] : [entries.extra]),
    '---',
    '',
    '## Description',
    '',
    'Body.',
    '',
    '## Log',
    '',
    ...(entries.log ?? ["- '2026-10-17T09:00:00Z' owner@desk — created in inbox"]),
    '',
  ].join('\n');
}

const file = (path: string, text: string): DriftFile => ({ path, text });

describe('parseArchivedStamp', () => {
  it('finds the newest machine-shaped archived marker', () => {
    const text = ticketFile({
      log: [
        "- '2026-10-18T10:00:00Z' owner@desk — archived",
        "- '2026-10-17T09:00:00Z' owner@desk — inbox -> build",
        "- '2026-10-19T08:00:00Z' owner@desk — archived",
      ],
    });
    expect(parseArchivedStamp(text)).toBe('2026-10-19T08:00:00Z');
  });

  it('is null without a marker, and a revive line is not a marker', () => {
    expect(parseArchivedStamp(ticketFile({}))).toBeNull();
    const revived = ticketFile({
      log: ["- '2026-10-18T10:00:00Z' owner@desk — archive -> build"],
    });
    expect(parseArchivedStamp(revived)).toBeNull();
  });
});

describe('detectDrift', () => {
  it('leaves a consistent ticket alone', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/50-build/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z', build: '2026-10-18T09:00:00Z' },
            log: ["- '2026-10-18T09:00:00Z' owner@desk — inbox -> build"],
          }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toEqual([]);
  });

  it('detects an unstamped move into a known phase — from is the newest stamp holder', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/50-build/T-0001.md',
          ticketFile({ entered: { inbox: '2026-10-17T09:00:00Z' } }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toEqual([
      {
        kind: 'move',
        id: 'T-0001',
        path: 'tickets/50-build/T-0001.md',
        phaseDir: '50-build',
        phase: 'build',
        from: 'inbox',
      },
    ]);
  });

  it('detects backwards and skipping moves alike — logged, never judged', () => {
    const backwards = detectDrift(
      [
        file(
          'tickets/inbox/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z', build: '2026-10-18T09:00:00Z' },
          }),
        ),
      ],
      PIPELINE,
    );
    expect(backwards).toHaveLength(1);
    expect(backwards[0]!.from).toBe('build');
    expect(backwards[0]!.phase).toBe('inbox');
  });

  it('a hand-created file without any stamp moves from null (logged as unknown)', () => {
    const drifts = detectDrift(
      [file('tickets/20-prioritized/T-0001.md', ticketFile({}))],
      PIPELINE,
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.from).toBeNull();
  });

  it('a revive: the archived marker dominating the stamps makes from archive', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/30-plan/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z' },
            log: [
              "- '2026-10-17T09:00:00Z' owner@desk — created in inbox",
              "- '2026-10-18T10:00:00Z' owner@desk — archived",
            ],
          }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.kind).toBe('move');
    expect(drifts[0]!.from).toBe('archive');
  });

  it('an archived file without a marker needs treatment, from the newest stamp', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/archive/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z', build: '2026-10-18T09:00:00Z' },
          }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toEqual([
      {
        kind: 'archive',
        id: 'T-0001',
        path: 'tickets/archive/T-0001.md',
        phaseDir: 'archive',
        phase: 'archive',
        from: 'build',
      },
    ]);
  });

  it('an archived file with a marker newer than every stamp is the fixpoint', () => {
    const archived = ticketFile({
      entered: { inbox: '2026-10-17T09:00:00Z', build: '2026-10-18T09:00:00Z' },
      log: [
        "- '2026-10-17T09:00:00Z' owner@desk — created in inbox",
        "- '2026-10-19T08:00:00Z' owner@desk — archived",
      ],
    });
    expect(detectDrift([file('tickets/archive/T-0001.md', archived)], PIPELINE)).toEqual([]);
    // A body edit after archiving changes no stamp — still no re-fire.
    expect(detectDrift([file('tickets/archive/T-0001.md', `${archived}\nMore prose.\n`)], PIPELINE)).toEqual([]);
  });

  it('a re-archive after a revive is detected (marker older than the newest stamp)', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/archive/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z', build: '2026-10-18T09:00:00Z' },
            log: [
              "- '2026-10-18T07:00:00Z' owner@desk — archived",
              "- '2026-10-17T09:00:00Z' owner@desk — created in inbox",
            ],
          }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.kind).toBe('archive');
    expect(drifts[0]!.from).toBe('build');
  });

  it('skips a ticket with a live run map (the runner owns the file)', () => {
    const drifts = detectDrift(
      [
        file(
          'tickets/50-build/T-0001.md',
          ticketFile({
            entered: { inbox: '2026-10-17T09:00:00Z' },
            extra: 'run: {pid: 4242, started-at: \'2026-10-18T09:00:00Z\', stream: R-x}',
          }),
        ),
      ],
      PIPELINE,
    );
    expect(drifts).toEqual([]);
  });

  it('skips unparseable frontmatter and error-flagged files', () => {
    const noFence = detectDrift([file('tickets/50-build/T-0001.md', 'just body')], PIPELINE);
    expect(noFence).toEqual([]);
    const badYaml = detectDrift([file('tickets/50-build/T-0001.md', '---\nid: [broken\n---\n')], PIPELINE);
    expect(badYaml).toEqual([]);
    const idMismatch = detectDrift(
      [file('tickets/50-build/T-0001.md', ticketFile({}).replace('id: T-0001', 'id: T-0009'))],
      PIPELINE,
    );
    expect(idMismatch).toEqual([]);
  });

  it('skips unknown directories and _meta — a badge, not a move', () => {
    const drifts = detectDrift(
      [
        file('tickets/35-qa/T-0001.md', ticketFile({})),
        file('tickets/_meta/T-0002.md', ticketFile({}).replaceAll('T-0001', 'T-0002')),
      ],
      PIPELINE,
    );
    expect(drifts).toEqual([]);
  });
});
