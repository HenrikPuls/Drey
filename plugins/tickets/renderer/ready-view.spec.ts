// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { focusDecisionCard, readyBarNode, readyCardNode, storyNode, type ReadyViewDeps } from './ready-view';
import { goToDecisionCard } from './ticket-document/dom';
import type { StepCard } from '../shared/step-card';
import type { ParsedChanges, StoryItem, StoryTotals } from '../shared/changes';

const CHANGES: ParsedChanges = {
  forYou: 'The command palette opens once, even when Ctrl+P is pressed twice quickly.\nNothing else you can see has changed.',
  files: [
    { status: 'M', path: 'src/app/palette/palette.service.ts', why: 'a second open while one is opening is ignored' },
    { status: 'A', path: 'src/app/palette/palette.service.spec.ts', why: 'two new tests' },
    { status: 'D', path: 'src/app/palette/old.ts', why: '' },
  ],
  checks: ['412 tests passed, lint, the four typechecks, import cycles'],
  howToTry: '1. Launch this version · 2. Press Ctrl+P twice, fast · 3. One palette opens',
};

const deps = (): ReadyViewDeps => ({
  onLaunch: vi.fn(),
  onAccept: vi.fn(),
  onSendBack: vi.fn(),
  icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
});

const GATE: StepCard = { kind: 'gate', acceptLabel: 'Move to Commit', canLaunch: true, canSendBack: true };
const FINAL: StepCard = { kind: 'final', acceptLabel: 'Archive', canLaunch: false, canSendBack: false };

const click = (node: Element): void => {
  (node as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

describe('readyCardNode (req-75 W3)', () => {
  it('renders the header chips, every section, the buttons and the hint', () => {
    const d = deps();
    const card = readyCardNode(d, {
      id: 'T-0126',
      title: 'Palette opens twice on slow CI',
      track: 'auto',
      repo: 'drey',
      card: GATE,
      result: null,
      changes: CHANGES,
    });
    expect(card.querySelector('.tickets-ready-kicker')!.textContent).toBe('T-0126');
    expect(card.querySelector('.tickets-ready-title')!.textContent).toBe('Palette opens twice on slow CI');
    expect([...card.querySelectorAll('.tickets-ready-chip')].map((n) => n.textContent)).toEqual([
      'Auto track',
      'drey',
      'Needs your decision',
    ]);
    expect(card.querySelector('.tickets-ready-for-you')!.textContent).toContain('opens once');
    // The worker's fixed closing line reads muted, under the text.
    expect(card.querySelector('.tickets-ready-muted')!.textContent).toBe('Nothing else you can see has changed.');
    const files = [...card.querySelectorAll('.tickets-ready-file')];
    expect(files).toHaveLength(3);
    expect(files[0]!.querySelector('.tickets-ready-status-M')!.textContent).toBe('M');
    expect(files[0]!.querySelector('.tickets-ready-path')!.textContent).toBe('src/app/palette/palette.service.ts');
    expect(files[0]!.querySelector('.tickets-ready-why')!.textContent).toContain('second open');
    expect(files[2]!.querySelector('.tickets-ready-status-D')).not.toBeNull();
    expect(card.querySelector('.tickets-ready-tick')!.textContent).toBe('✓');
    expect(card.textContent).toContain('1. Launch this version');
    expect(card.textContent).toContain('Move to Commit');
    expect(card.textContent).toContain('Send back…');
    expect(card.querySelector('.tickets-ready-hint')!.textContent).toContain('Move to Commit moves the ticket on');

    click(card.querySelector('.tickets-ready-launch')!);
    click([...card.querySelectorAll('.tickets-ready-actions button')].find((b) => b.textContent === 'Move to Commit')!);
    click(card.querySelector('.tickets-ready-sendback')!);
    expect(d.onLaunch).toHaveBeenCalledTimes(1);
    expect(d.onAccept).toHaveBeenCalledTimes(1);
    expect(d.onSendBack).toHaveBeenCalledTimes(1);
  });

  it('the final card leads with the delivered report and offers Archive alone', () => {
    const d = deps();
    const card = readyCardNode(d, {
      id: 'T-0001',
      title: null,
      track: null,
      repo: null,
      card: FINAL,
      result: 'Merged as 035f139 into main and pushed.',
      changes: CHANGES,
    });
    const headings = [...card.querySelectorAll('.tickets-ready-section > b')].map((n) => n.textContent);
    expect(headings[0]).toBe('What was delivered');
    expect(card.querySelector('.tickets-ready-for-you')!.textContent).toContain('035f139');
    expect([...card.querySelectorAll('.tickets-ready-actions button')].map((b) => b.textContent)).toEqual(['Archive']);
    expect(card.querySelector('.tickets-ready-launch')).toBeNull();
    expect(card.querySelector('.tickets-ready-sendback')).toBeNull();
    expect([...card.querySelectorAll('.tickets-ready-chip')].map((n) => n.textContent)).toEqual(['Done']);
    expect(card.querySelector('.tickets-ready-title')!.textContent).toBe('(untitled)');
    click(card.querySelector('.tickets-ready-actions button')!);
    expect(d.onAccept).toHaveBeenCalledTimes(1);
  });

  it('a gate without a runnable build hides Launch and promotes the move', () => {
    const card = readyCardNode(deps(), {
      id: 'T-0003',
      title: 'Plan only',
      track: null,
      repo: null,
      card: { ...GATE, canLaunch: false },
      result: null,
      changes: null,
    });
    expect(card.querySelector('.tickets-ready-launch')).toBeNull();
    const move = card.querySelector('.tickets-ready-actions button')!;
    expect(move.textContent).toBe('Move to Commit');
    expect(move.className).toContain('tickets-takeover-btn-primary');
  });

  it('leaves missing sections out and still shows the buttons without a Changes section', () => {
    const card = readyCardNode(deps(), {
      id: 'T-0002',
      title: 'No changes yet',
      track: null,
      repo: null,
      card: GATE,
      result: null,
      changes: { forYou: null, files: [], checks: [], howToTry: null },
    });
    expect(card.textContent).not.toContain('What changed for you');
    expect(card.textContent).not.toContain('Where');
    expect(card.textContent).not.toContain('Checks');
    expect(card.textContent).not.toContain('How to try it');
    expect(card.querySelector('.tickets-ready-launch')).not.toBeNull();
    expect(card.querySelector('.tickets-ready-hint')).not.toBeNull();
  });
});

describe('readyBarNode (the fold strip)', () => {
  const data = { id: 'T-0009', title: 'Fold me', track: null, repo: null, card: GATE, result: null, changes: null };

  it('open: id, title and state, with no buttons — the card below carries them', () => {
    const bar = readyBarNode(deps(), data, { open: true, onToggle: vi.fn() });
    expect(bar.querySelector('.tickets-ready-bar-title')!.textContent).toBe('Fold me');
    expect(bar.querySelector('.tickets-ready-fold')!.getAttribute('aria-expanded')).toBe('true');
    expect(bar.querySelector('.tickets-ready-actions')).toBeNull();
  });

  it('folded: the gate stays decidable from the strip, and the toggle unfolds', () => {
    const onToggle = vi.fn();
    const d = deps();
    const bar = readyBarNode(d, data, { open: false, onToggle });
    expect(bar.querySelector('.tickets-ready-fold')!.getAttribute('aria-expanded')).toBe('false');
    click([...bar.querySelectorAll('.tickets-ready-actions button')].find((b) => b.textContent === 'Move to Commit')!);
    expect(d.onAccept).toHaveBeenCalledTimes(1);
    click(bar.querySelector('.tickets-ready-fold')!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('storyNode (req-75 W3)', () => {
  const story: readonly StoryItem[] = [
    { at: '09:02', what: 'Captured', who: 'you' },
    { at: '09:16', what: 'Built and tested', who: 'opencode · glm-5.3-flash' },
  ];

  it('draws How it got here, one row per beat and the totals line', () => {
    const totals: StoryTotals = { minutes: 14, tokens: 96_000 };
    const node = storyNode({ story, totals });
    expect(node.querySelector('.tickets-story-head')!.textContent).toBe('How it got here');
    const rows = [...node.querySelectorAll('.tickets-story-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.tickets-story-at')!.textContent).toBe('09:02');
    expect(rows[0]!.textContent).toContain('Captured');
    expect(rows[0]!.textContent).toContain('you');
    expect(rows[1]!.textContent).toContain('opencode · glm-5.3-flash');
    expect(node.querySelector('.tickets-story-total')!.textContent).toBe('Total 14 min · 96.0k tokens');
  });

  it('leaves the totals parts out that have no data', () => {
    expect(storyNode({ story, totals: { minutes: null, tokens: 3_500 } }).querySelector('.tickets-story-total')!.textContent).toBe('3.5k tokens');
    expect(storyNode({ story, totals: { minutes: 3, tokens: null } }).querySelector('.tickets-story-total')!.textContent).toBe('Total 3 min');
    expect(storyNode({ story: [], totals: { minutes: null, tokens: null } }).querySelector('.tickets-story-total')).toBeNull();
  });
});

describe('the decision card is the one Accept (req-97)', () => {
  const data = { id: 'T-0126', title: 'Palette', track: null, repo: null, card: GATE, changes: null, result: null };

  it('"Decision waiting · go to the card" focuses the card of that ticket', () => {
    const card = readyCardNode(deps(), data);
    document.body.append(card);
    expect(card.dataset['decisionCard']).toBe('T-0126');
    expect(goToDecisionCard('T-0126')).toBe(true);
    expect(document.activeElement).toBe(card.querySelector('button'));
    expect(goToDecisionCard('T-9999')).toBe(false);
    card.remove();
    expect(goToDecisionCard('T-0126')).toBe(false);
  });

  it('finds the folded bar as well, preferring the card', () => {
    const bar = readyBarNode(deps(), data, { open: false, onToggle: vi.fn() });
    document.body.append(bar);
    expect(focusDecisionCard(document, 'T-0126')).toBe(true);
    bar.remove();
  });
});
