// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../../shared/i18n';
import { GO_TO_DECISION_CARD, cardNode, costNode, decisionLinkNode, proofNode, type CardFacts } from './dom';
import type { ProofView } from './model';

const proof: ProofView = {
  summary: '2/2 green.',
  allPassed: true,
  stamp: 'Tested on 2026-11-04 by Tessa, Electron 34.2.0 on win32.',
  tester: 'Tessa',
  checks: [
    { label: 'One palette', passed: true, note: 'tessa', at: '0:12' },
    { label: 'Escape closes it', passed: false, note: 'focus lost', at: null },
  ],
  shots: [{ file: 'verify-1.png', caption: 'shot 1 · One palette' }],
  video: { file: 'v.webm', notKept: null, chapters: [{ atMs: 12_000, at: '0:12', label: 'One palette' }] },
  findings: ['Slow start.'],
};

describe('proofNode', () => {
  it('draws the verdict, the checks and one row of tiles', () => {
    const open = vi.fn();
    const node = proofNode({ i18n, vaultId: 'v1', openFile: open }, proof);
    expect(node.querySelector('.tickets-doc-kicker')?.textContent).toBe('Proof');
    expect(node.querySelector('.tickets-doc-verdict')?.textContent).toBe('2/2 green.');
    expect(node.querySelector('.tickets-doc-verdict-box')?.textContent).toBe('2/2 green. Tested on 2026-11-04 by Tessa, Electron 34.2.0 on win32.');
    expect(node.querySelectorAll('.tickets-doc-check')).toHaveLength(2);
    expect(node.querySelector('.tickets-doc-check.is-pass .tickets-doc-check-meta')?.textContent).toBe('tessa · 0:12');
    expect(node.querySelector('img')?.getAttribute('src')).toBe('drey-asset://v1/asset/tickets/attachments/verify-1.png');
    node.querySelector<HTMLButtonElement>('button.tickets-doc-shot')!.click();
    expect(open).toHaveBeenCalledWith('tickets/attachments/verify-1.png');
    const video = node.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('drey-asset://v1/asset/tickets/videos/v.webm');
    expect(video.controls).toBe(false);
    expect(node.querySelector('.tickets-doc-shot.is-video')?.textContent).toBe('video · 1 chapter');
    expect(node.querySelector('.tickets-doc-findings li')?.textContent).toBe('Slow start.');
  });

  it('gives the video its controls when the tile is pressed', () => {
    const node = proofNode({ i18n, vaultId: null, openFile: vi.fn() }, proof);
    node.querySelector<HTMLElement>('.tickets-doc-shot.is-video')!.click();
    expect(node.querySelector('video')!.controls).toBe(true);
  });

  it('jumps to a check from its time', () => {
    const node = proofNode({ i18n, vaultId: null, openFile: vi.fn() }, proof);
    const video = node.querySelector('video')!;
    video.play = vi.fn(async () => undefined);
    node.querySelector<HTMLElement>('.tickets-doc-check-meta.is-jump')!.click();
    expect(video.currentTime).toBe(12);
  });

  it('replaces the video with the not-kept line', () => {
    const node = proofNode({ i18n, vaultId: null, openFile: vi.fn() }, { ...proof, video: { file: null, notKept: 'Video not kept: 31.2 MB exceeds the 25 MB limit.', chapters: [] } });
    expect(node.querySelector('video')).toBeNull();
    expect(node.querySelector('.tickets-doc-note')?.textContent).toBe('Video not kept: 31.2 MB exceeds the 25 MB limit.');
  });

  it('hides tiles and findings when the ticket carries none', () => {
    const node = proofNode({ i18n, vaultId: null, openFile: vi.fn() }, { ...proof, shots: [], video: null, findings: [] });
    expect(node.querySelector('img, video, .tickets-doc-shots, .tickets-doc-findings')).toBeNull();
  });
});

describe('costNode', () => {
  const row = { phase: 'Build', model: 'Ben · sonnet', persona: 'Ben', modelName: 'sonnet', minutes: 14, tokens: '88k', time: '14 min', cost: '$0.94', pending: false, bad: false, meta: '' };
  const view = {
    rows: [row, { ...row, phase: 'Review', persona: '', modelName: '', minutes: null, tokens: '', time: '', cost: '', pending: true }],
    total: { tokens: '88k', time: '14 min', cost: '$0.94' },
  };

  it('says the total in its kicker and draws the runs as the board does', () => {
    const node = costNode(i18n, view);
    expect(node.querySelector('.tickets-doc-kicker')?.textContent).toBe('Cost · $0.94 in total');
    const rows = Array.from(node.querySelectorAll('.tickets-doc-table-row'));
    expect(rows.map((r) => Array.from(r.children).map((c) => c.textContent))).toEqual([
      ['Phase', 'Model', 'Tokens', 'Time', 'Cost'],
      ['Build · Ben', 'sonnet', '88k', '14m', '$0.94'],
      ['Review', 'no run yet'],
      ['Total', '', '88k', '14m', '$0.94'],
    ]);
    expect(rows[2]!.classList.contains('is-pending')).toBe(true);
  });
});

describe('decisionLinkNode', () => {
  it('focuses the card that answers the event, and runs the fallback when none does', () => {
    const fallback = vi.fn();
    const link = decisionLinkNode(i18n, 'T-0121', fallback);
    expect(link.textContent).toBe('Decision waiting · go to the card ›');
    const seen: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; handled: boolean }>).detail;
      seen.push(detail.id);
      detail.handled = true;
    };
    document.addEventListener(GO_TO_DECISION_CARD, listener);
    link.click();
    document.removeEventListener(GO_TO_DECISION_CARD, listener);
    expect(seen).toEqual(['T-0121']);
    expect(fallback).not.toHaveBeenCalled();

    link.click();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('cardNode', () => {
  const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
    shape: 'flow',
    id: 'T-0118',
    pill: { label: 'Ready to try', tone: 'mint' },
    kind: '',
    issues: null,
    flow: [
      { title: 'Build', state: 'past', note: null, skipped: false },
      { title: 'Accept', state: 'current', note: '(your turn)', skipped: false },
    ],
    priority: 'Normal',
    worker: 'Tessa',
    workerNote: '',
    avatar: null,
    repo: 'drey',
    branch: 't/T-0118',
    cost: '$1.84 in total · est. $1.50–2.40 · from 3 runs',
    gate: '',
    decide: true,
    canReview: true,
    ...over,
  });
  const actions = () => ({ i18n, onThread: vi.fn(), onReview: vi.fn(), onFlow: vi.fn() });
  const labels = (node: HTMLElement): string[] => Array.from(node.querySelectorAll('.tickets-card-top button')).map((b) => b.textContent ?? '');
  const grid = (node: HTMLElement): string[] => Array.from(node.querySelectorAll('.tickets-card-label')).map((l) => l.textContent ?? '');

  it('row 7: the state once, the link, Open Review and Thread, Flow / Worker / Cost', () => {
    const a = actions();
    const node = cardNode(a, facts());
    expect(node.classList.contains('is-flow')).toBe(true);
    expect(node.querySelector('.tickets-head-phase')?.textContent).toBe('Ready to try');
    expect(node.querySelector('.tickets-doc-status.is-mint')).not.toBeNull();
    expect(node.querySelector('.tickets-doc-decision-link')).not.toBeNull();
    expect(labels(node)).toEqual(['Open Review', 'Thread']);
    expect(grid(node)).toEqual(['Flow', 'Worker', 'Cost']);
    expect(Array.from(node.querySelector('.tickets-doc-chain')!.children).map((c) => c.textContent)).toEqual(['✓ Build', '·', 'Accept', '(your turn)', 'Change']);
    expect(node.querySelector('.tickets-doc-cost-fact')?.textContent).toBe('$1.84 in total · est. $1.50–2.40 · from 3 runs');
    node.querySelectorAll<HTMLButtonElement>('.tickets-card-top button').forEach((b) => b.click());
    expect([a.onReview, a.onThread].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it('9a: Priority / Worker / Flow / Repo, the flow in arrows with its Change link, no Review before there are changes', () => {
    const a = actions();
    const node = cardNode(a, facts({ shape: 'early', decide: false, canReview: false, worker: 'opencode', workerNote: '· default', flow: [{ title: 'Build', state: 'future', note: null, skipped: false }, { title: 'Accept', state: 'future', note: null, skipped: false }] }));
    expect(node.classList.contains('is-early')).toBe(true);
    expect(labels(node)).toEqual(['Thread']);
    expect(grid(node)).toEqual(['Priority', 'Worker', 'Flow', 'Repo']);
    expect(node.textContent).toContain('Build → Accept');
    expect(node.textContent).toContain('opencode · default');
    expect(node.querySelector('.tickets-card-branch')?.textContent).toBe('t/T-0118');
    node.querySelector<HTMLButtonElement>('.tickets-doc-flow')!.click();
    expect(a.onFlow).toHaveBeenCalledTimes(1);
  });

  it('7b: the worker is a picture', () => {
    const node = cardNode(actions(), facts({ avatar: { initials: 'P', color: '#123', name: 'Paul' } }));
    expect(node.querySelector<HTMLElement>('.tickets-doc-avatar')?.title).toBe('Paul');
  });

  it('adds the issue badge and the gate only when there is something to say', () => {
    const plain = cardNode(actions(), facts({ decide: false }));
    expect(plain.querySelector('.tickets-issues, .tickets-doc-gate, .tickets-doc-decision-link')).toBeNull();
    const full = cardNode(actions(), facts({ issues: { count: 2, worst: 'error', title: 'x' }, gate: 'Waits for you: which one?' }));
    expect(full.querySelector('.tickets-issues-error')?.textContent).toBe('2');
    expect(full.querySelector('.tickets-doc-gate')?.textContent).toBe('Waits for you: which one?');
  });
});
