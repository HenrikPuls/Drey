import { describe, expect, it } from 'vitest';
import { renderVerificationSection } from '../../../../packages/tickets-engine/src/core/verification';
import { renderVerlaufLine } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { VerificationReport } from '../../../../packages/tickets-engine/src/contracts/verify';
import {
  assetUrl,
  chainOf,
  costSummary,
  costTableOf,
  costTableOfText,
  estimateLine,
  offsetWords,
  proofOfText,
  sectionBodyRange,
  tokenWords,
  usdLabel,
} from './model';
import { parseVerlaufEntries } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { PipelinePhase, TicketCard } from '../../shared/tickets';

const report: VerificationReport = {
  testedAt: '2026-11-04T10:00:00Z',
  tester: 'verify@box',
  environment: 'Electron 34.2.0 on win32',
  criteria: [
    { command: 'One palette after a double Ctrl+P', passed: true, screenshot: 'verify-1.png', note: null },
    { command: 'Escape closes it', passed: true, screenshot: 'verify-2.png', note: 'focus stays' },
  ],
  findings: ['The first shot was slow.'],
  video: 'verify-20261104-T-0118.webm',
  videoChapters: [
    { atMs: 12_000, label: 'One palette after a double Ctrl+P' },
    { atMs: 24_000, label: 'Escape closes it' },
  ],
};

const phase = (id: string, title: string, handover: string, persona: string | null = null): PipelinePhase =>
  ({ id, title, handover, persona, wip: null, claim: false }) as unknown as PipelinePhase;

describe('words', () => {
  it('writes money and tokens as the phone does', () => {
    expect(usdLabel(1.836)).toBe('$1.84');
    expect(usdLabel(0)).toBeNull();
    expect(usdLabel(null)).toBeNull();
    expect(tokenWords(48_000)).toBe('48k');
    expect(tokenWords(3_400_000)).toBe('3.4M');
    expect(tokenWords(800)).toBe('800');
    expect(offsetWords(72_000)).toBe('1:12');
    expect(offsetWords(5_000)).toBe('0:05');
  });

  it('builds the asset URL the editor images use', () => {
    expect(assetUrl('v1', 'tickets/videos/a b.webm')).toBe('drey-asset://v1/asset/tickets/videos/a%20b.webm');
    expect(assetUrl(null, 'x.png')).toBe('drey-asset://asset/x.png');
  });
});

describe('sectionBodyRange', () => {
  const text = '# T\n\n## Verification\n\nLine A\n- [x] `c`\n\n```\n## not a heading\n```\n\n## Log\n- x\n';

  it('spans from the first body line to the last non-blank one', () => {
    const range = sectionBodyRange(text, 'Verification')!;
    expect(text.slice(range.from, range.to)).toBe('Line A\n- [x] `c`\n\n```\n## not a heading\n```');
  });

  it('is null for a missing or empty section and tolerates CRLF', () => {
    expect(sectionBodyRange('# T\n\n## Log\n- x', 'Verification')).toBeNull();
    expect(sectionBodyRange('## Verification\n\n## Log\n', 'Verification')).toBeNull();
    const crlf = '## Verification\r\nbody\r\n\r\n## Log\r\n';
    const range = sectionBodyRange(crlf, 'Verification')!;
    expect(crlf.slice(range.from, range.to)).toBe('body');
  });
});

describe('proofOfText', () => {
  it('is null without a Verification section', () => {
    expect(proofOfText('# T\n')).toBeNull();
  });

  it('reads summary, checks with chapter times, shots, video and findings', () => {
    const proof = proofOfText(`# T\n\n${renderVerificationSection(report)}`)!;
    expect(proof.summary).toBe('2/2 green.');
    expect(proof.allPassed).toBe(true);
    expect(proof.stamp).toBe('Tested on 2026-11-04 by the verify run — Electron 34.2.0 on win32.');
    expect(proof.checks.map((c) => [c.label, c.at, c.note])).toEqual([
      ['One palette after a double Ctrl+P', '0:12', null],
      ['Escape closes it', '0:24', 'focus stays'],
    ]);
    expect(proof.shots.map((s) => s.file)).toEqual(['verify-1.png', 'verify-2.png']);
    expect(proof.shots[0]!.caption).toBe('shot 1 · One palette after a double Ctrl+P');
    expect(proof.video?.file).toBe('verify-20261104-T-0118.webm');
    expect(proof.video?.chapters).toHaveLength(2);
    expect(proof.findings).toEqual(['The first shot was slow.']);
  });

  it('counts failures and keeps the removal note', () => {
    const failing: VerificationReport = {
      ...report,
      criteria: [{ ...report.criteria[0]!, passed: false }, report.criteria[1]!],
      video: null,
      videoRemoved: true,
      videoChapters: [],
    };
    const proof = proofOfText(renderVerificationSection(failing))!;
    expect(proof.summary).toBe('1/2 green, 1 failing.');
    expect(proof.allPassed).toBe(false);
    expect(proof.video).toEqual({ file: null, removed: true, chapters: [] });
  });
});

describe('cost table', () => {
  const lines = [
    renderVerlaufLine({ phase: 'plan', persona: 'paul', model: 'sonnet', tokens: '21k', cost: 0.31, dauer: '4m', ausgang: 'handed-over' }),
    renderVerlaufLine({ phase: 'build', persona: 'ben', model: 'sonnet', tokens: '88k', cost: 0.94, dauer: '14m', ausgang: 'handed-over' }),
    renderVerlaufLine({ phase: 'review', persona: 'ralf', model: 'sonnet', tokens: '30k', cost: null, dauer: '', ausgang: 'failed' }),
  ];
  const text = `# T\n\n## Verlauf\n\n${lines.join('\n')}\n`;

  it('has one row per run and never counts an unknown cost as zero', () => {
    const table = costTableOfText(text, (id) => id.toUpperCase())!;
    expect(table.rows.map((r) => [r.step, r.who, r.tokens, r.time, r.cost])).toEqual([
      ['PLAN', 'Paul · sonnet', '21k', '4 min', '$0.31'],
      ['BUILD', 'Ben · sonnet', '88k', '14 min', '$0.94'],
      ['REVIEW', 'Ralf · sonnet', '30k', '', '—'],
    ]);
    expect(table.rows[2]!.outcome).toBe('failed');
    expect(table.total).toBe('$1.25');
    expect(table.totalTime).toBe('18 min');
    expect(table.totalTokens).toBe('139k');
  });

  it('is null for a ticket that has not run, and summarises so far / in total', () => {
    expect(costTableOfText('# T\n', (id) => id)).toBeNull();
    const entries = parseVerlaufEntries(text);
    expect(costTableOf([], (id) => id).total).toBeNull();
    expect(costSummary(entries, true).label).toBe('$1.25 in total');
    expect(costSummary(entries, false).label).toBe('$1.25 so far');
    expect(costSummary([], true).label).toBeNull();
  });
});

describe('estimateLine', () => {
  it('states its basis', () => {
    expect(estimateLine({ gate: 'build', persona: 'ben', model: 'sonnet', runs: 6, cost: 0.3, minutes: 9, tokens: 48_000 }, 'Build')).toBe(
      'About $0.30 · 9 min · 48k tokens — median of 6 earlier Build runs by Ben on sonnet.',
    );
  });
});

describe('chainOf', () => {
  const pipeline = [
    phase('ideas', 'Ideas', 'manual'),
    phase('plan', 'Plan', 'agent plan', 'paul'),
    phase('build', 'Build', 'agent build', 'ben'),
    phase('review', 'Review', 'agent review', 'ralf'),
    phase('commit', 'Commit', 'manual'),
    phase('done', 'Done', 'none'),
  ];
  const card = (meta: Record<string, unknown>): TicketCard =>
    ({ id: 'T-1', meta: { chain: [], persona: null, ...meta } }) as unknown as TicketCard;
  const personas = [{ id: 'ben', title: 'Ben' }];

  it('shows the working phases up to the owner checkpoint, with who does each', () => {
    const chain = chainOf({ pipeline, currentPhaseId: 'build', card: card({}), personas });
    expect(chain.map((s) => [s.title, s.state, s.who])).toEqual([
      ['Plan', 'past', 'Paul'],
      ['Build', 'current', 'Ben'],
      ['Review', 'future', 'Ralf'],
      ['Commit', 'future', 'you'],
    ]);
    expect(chain[1]!.personaId).toBe('ben');
    expect(chain[3]!.personaId).toBeNull();
  });

  it('lets the ticket pin and the chain delta override the column', () => {
    const chain = chainOf({
      pipeline,
      currentPhaseId: 'plan',
      card: card({ persona: 'tessa', chain: [{ kind: 'skip', phase: 'review' }] }),
      personas,
    });
    expect(chain.find((s) => s.phase === 'plan')!.who).toBe('Tessa');
    expect(chain.find((s) => s.phase === 'review')!.skipped).toBe(true);
  });
});
