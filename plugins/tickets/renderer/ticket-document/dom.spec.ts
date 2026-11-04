// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { actionBarNode, costNode, proofNode, stripNode } from './dom';
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
  it('lists the runs and the total row', () => {
    const node = costNode({
      rows: [{ step: 'Build', who: 'Ben · sonnet', tokens: '88k', time: '14 min', cost: '$0.94', outcome: 'handed over' }],
      total: '$0.94',
      totalTokens: '88k',
      totalTime: '14 min',
    });
    expect(Array.from(node.querySelectorAll('th')).map((c) => c.textContent)).toEqual(['Phase', 'Model', 'Tokens', 'Time', 'Cost']);
    expect(node.querySelector('tbody tr')?.textContent).toBe('BuildBen · sonnet88k14 min$0.94');
    expect(node.querySelector('tfoot tr')?.textContent).toBe('Total88k14 min$0.94');
    expect(node.querySelector('.tickets-doc-total')?.textContent).toBe('$0.94');
  });
});

describe('actionBarNode', () => {
  const icon = (): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const deps = () => ({ icon, onSendBack: vi.fn(), onAccept: vi.fn(), onThread: vi.fn(), onReview: vi.fn() });
  const labels = (node: HTMLElement): string[] => Array.from(node.querySelectorAll('button')).map((b) => b.textContent ?? '');

  it('offers all four at a checkpoint and calls through', () => {
    const d = deps();
    const node = actionBarNode(d, { decide: true, acceptLabel: 'Accept and move to Commit' });
    expect(labels(node)).toEqual(['Send back…', 'Accept and move to Commit', 'Thread', 'Open Review']);
    node.querySelectorAll('button').forEach((b) => b.click());
    expect([d.onSendBack, d.onAccept, d.onThread, d.onReview].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it('keeps only Thread and Open Review off a checkpoint', () => {
    expect(labels(actionBarNode(deps(), { decide: false, acceptLabel: 'Accept' }))).toEqual(['Thread', 'Open Review']);
  });
});

describe('stripNode', () => {
  it('shows status, persona, cost, estimate, chain and gate', () => {
    const node = stripNode({
      status: { label: 'Ready to try', tone: 'needs', line: 'checks green' },
      who: 'Tessa',
      cost: '$1.84 in total',
      estimate: { short: '$1.50', basis: 'About $1.50 — median of 5 earlier Test runs by Tessa on sonnet.' },
      chain: [
        { phase: 'build', title: 'Build', state: 'past', who: 'Ben', personaId: 'ben', checkpoint: false, inserted: false, skipped: false, notify: false },
        { phase: 'commit', title: 'Accept', state: 'current', who: 'you', personaId: null, checkpoint: true, inserted: false, skipped: false, notify: false },
      ],
      gate: 'Waits for you: should it move the section?',
    });
    expect(node.querySelector('.tickets-doc-status')?.textContent).toBe('Ready to try');
    expect(node.querySelector('.tickets-doc-who')?.textContent).toBe('Tessa');
    expect(node.querySelector('.tickets-doc-cost-fact')?.textContent).toBe('$1.84 in total');
    expect(node.querySelector('.tickets-doc-estimate')?.textContent).toBe('est. $1.50');
    expect((node.querySelector('.tickets-doc-estimate') as HTMLElement).title).toContain('median of 5');
    expect(Array.from(node.querySelectorAll('.tickets-doc-step')).map((s) => s.textContent)).toEqual(['✓BuildBen', '◆Acceptyou']);
    expect(node.querySelector('.tickets-doc-gate')?.textContent).toBe('Waits for you: should it move the section?');
  });

  it('omits what it does not have', () => {
    const node = stripNode({ status: { label: 'Build', tone: 'idle', line: '' }, who: '', cost: null, estimate: null, chain: [], gate: '' });
    expect(node.querySelector('.tickets-doc-who, .tickets-doc-cost-fact, .tickets-doc-estimate, .tickets-doc-chain, .tickets-doc-gate')).toBeNull();
  });
});
