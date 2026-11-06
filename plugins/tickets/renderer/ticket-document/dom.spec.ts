// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../../shared/i18n';
import { GO_TO_DECISION_CARD, actionBarNode, costNode, proofNode, stripNode } from './dom';
import type { ProofView } from './model';

const proof: ProofView = {
  summary: '2/2 green.',
  allPassed: true,
  stamp: 'Tested on 2026-11-04 by Tessa.',
  checks: [
    { label: 'One palette', passed: true, note: null, at: '0:12' },
    { label: 'Escape closes it', passed: false, note: 'focus lost', at: null },
  ],
  shots: [{ file: 'verify-1.png', caption: 'shot 1 · One palette' }],
  video: { file: 'v.webm', notKept: null, chapters: [{ atMs: 12_000, at: '0:12', label: 'One palette' }] },
  findings: ['Slow start.'],
};

describe('proofNode', () => {
  it('draws the verdict, the checks, the picture and the player', () => {
    const open = vi.fn();
    const node = proofNode({ vaultId: 'v1', openFile: open }, proof);
    expect(node.querySelector('.tickets-doc-verdict')?.textContent).toBe('2/2 green.');
    expect(node.querySelectorAll('.tickets-doc-check')).toHaveLength(2);
    expect(node.querySelector('.tickets-doc-check.is-fail .tickets-doc-check-meta')?.textContent).toBe('focus lost');
    const image = node.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('drey-asset://v1/asset/tickets/attachments/verify-1.png');
    (node.querySelector('.tickets-doc-shot-open') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('tickets/attachments/verify-1.png');
    const video = node.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('drey-asset://v1/asset/tickets/videos/v.webm');
    expect(video.controls).toBe(true);
    expect(node.querySelector('.tickets-doc-chapter')?.textContent).toBe('0:12 One palette');
    expect(node.querySelector('.tickets-doc-findings li')?.textContent).toBe('Slow start.');
  });

  it('replaces the player with the not-kept line', () => {
    const node = proofNode({ vaultId: null, openFile: vi.fn() }, { ...proof, video: { file: null, notKept: 'Video not kept: 31.2 MB exceeds the 25 MB limit.', chapters: [] } });
    expect(node.querySelector('video')).toBeNull();
    expect(node.querySelector('.tickets-doc-note')?.textContent).toBe('Video not kept: 31.2 MB exceeds the 25 MB limit.');
  });

  it('hides gallery and player when the ticket carries none', () => {
    const node = proofNode({ vaultId: null, openFile: vi.fn() }, { ...proof, shots: [], video: null, findings: [] });
    expect(node.querySelector('img, video, .tickets-doc-shots, .tickets-doc-findings')).toBeNull();
  });
});

describe('costNode', () => {
  const view = {
    rows: [
      { phase: 'Build', model: 'Ben · sonnet', tokens: '88k', time: '14 min', cost: '$0.94', pending: false, bad: false, meta: '' },
      { phase: 'Review', model: '', tokens: '', time: '', cost: '', pending: true, bad: false, meta: '' },
    ],
    total: { tokens: '88k', time: '14 min', cost: '$0.94' },
  };

  it('lists the runs, a quiet row for a phase without a run, and the total row', () => {
    const node = costNode(i18n, view);
    expect(Array.from(node.querySelectorAll('th')).map((c) => c.textContent)).toEqual(['Phase', 'Model', 'Tokens', 'Time', 'Cost']);
    const rows = Array.from(node.querySelectorAll('tbody tr'));
    expect(rows[0]!.textContent).toBe('BuildBen · sonnet88k14 min$0.94');
    expect(rows[1]!.textContent).toBe('Reviewno run yet');
    expect(rows[1]!.classList.contains('is-pending')).toBe(true);
    expect(node.querySelector('tfoot tr')?.textContent).toBe('Total88k14 min$0.94');
  });
});

describe('actionBarNode', () => {
  const icon = (): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const deps = () => ({ icon, decisionLinkText: 'Decision waiting · go to the card', onThread: vi.fn(), onReview: vi.fn() });
  const labels = (node: HTMLElement): string[] => Array.from(node.querySelectorAll('button')).map((b) => b.textContent ?? '');
  const bar = (decide: boolean) => ({ decide, acceptLabel: 'Accept and move to Commit', ticketId: 'T-0121' });

  it('carries no Accept or Send back at a checkpoint, only the link to the decision card (req-97)', () => {
    const d = deps();
    const node = actionBarNode(d, bar(true));
    expect(labels(node)).toEqual(['Thread', 'Open Review']);
    expect(node.querySelector('.tickets-doc-decision-link')?.textContent).toBe('Decision waiting · go to the card');
    node.querySelectorAll('button').forEach((b) => b.click());
    expect([d.onThread, d.onReview].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it('the link focuses the card that answers the event, and opens the thread when none does', () => {
    const d = deps();
    const node = actionBarNode(d, bar(true));
    const link = node.querySelector<HTMLAnchorElement>('.tickets-doc-decision-link')!;
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
    expect(d.onThread).not.toHaveBeenCalled();

    link.click();
    expect(d.onThread).toHaveBeenCalledTimes(1);
  });

  it('shows no link and only Thread and Open Review off a checkpoint', () => {
    const node = actionBarNode(deps(), bar(false));
    expect(labels(node)).toEqual(['Thread', 'Open Review']);
    expect(node.querySelector('.tickets-doc-decision-link')).toBeNull();
  });
});

describe('stripNode', () => {
  it('shows status, persona, cost, estimate, chain and gate', () => {
    const node = stripNode({
      status: { label: 'Needs you', tone: 'needs', kind: 'Question', line: 'waits for your answer' },
      who: 'Tessa',
      step: 'Step: Test',
      kind: 'Question',
      cost: '$1.20 so far',
      estimate: 'est. $3.00–5.20 · from 3 runs',
      chain: [
        { phase: 'build', title: 'Build', state: 'past', who: 'Ben', personaId: 'ben', checkpoint: false, inserted: false, skipped: false, notify: false },
        { phase: 'commit', title: 'Accept', state: 'current', who: 'you', personaId: null, checkpoint: true, inserted: false, skipped: false, notify: false },
      ],
      gate: 'Waits for you: should it move the section?',
    });
    expect(node.querySelector('.tickets-doc-status')?.textContent).toBe('Needs you');
    expect(node.querySelector('.tickets-doc-kind')?.textContent).toBe('Question');
    expect(node.querySelector('.tickets-doc-step-now')?.textContent).toBe('Step: Test');
    expect(node.querySelector('.tickets-doc-who')?.textContent).toBe('Tessa');
    expect(node.querySelector('.tickets-doc-cost-fact')?.textContent).toBe('$1.20 so far');
    expect(node.querySelector('.tickets-doc-estimate')?.textContent).toBe('est. $3.00–5.20 · from 3 runs');
    expect(Array.from(node.querySelectorAll('.tickets-doc-step')).map((s) => s.textContent)).toEqual(['✓BuildBen', '◆Acceptyou']);
    expect(node.querySelector('.tickets-doc-gate')?.textContent).toBe('Waits for you: should it move the section?');
  });

  it('omits what it does not have', () => {
    const node = stripNode({ status: { label: 'Build', tone: 'idle', kind: '', line: '' }, kind: '', who: '', step: '', cost: null, estimate: null, chain: [], gate: '' });
    expect(node.querySelector('.tickets-doc-kind, .tickets-doc-who, .tickets-doc-step-now, .tickets-doc-cost-fact, .tickets-doc-estimate, .tickets-doc-chain, .tickets-doc-gate')).toBeNull();
  });
});
