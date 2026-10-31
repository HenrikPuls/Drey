// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readyCardNode, storyNode, type ReadyViewDeps } from './ready-view';
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
      terminal: false,
      changes: CHANGES,
    });
    expect(card.querySelector('.tickets-ready-kicker')!.textContent).toBe('T-0126');
    expect(card.querySelector('.tickets-ready-title')!.textContent).toBe('Palette opens twice on slow CI');
    expect([...card.querySelectorAll('.tickets-ready-chip')].map((n) => n.textContent)).toEqual([
      'Auto track',
      'drey',
      'Ready to try',
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
    expect(card.textContent).toContain('Accept and merge');
    expect(card.textContent).toContain('Send back…');
    expect(card.querySelector('.tickets-ready-hint')!.textContent).toContain('worktree is removed');

    click(card.querySelector('.tickets-ready-launch')!);
    click([...card.querySelectorAll('.tickets-ready-actions button')].find((b) => b.textContent === 'Accept and merge')!);
    click(card.querySelector('.tickets-ready-sendback')!);
    expect(d.onLaunch).toHaveBeenCalledTimes(1);
    expect(d.onAccept).toHaveBeenCalledTimes(1);
    expect(d.onSendBack).toHaveBeenCalledTimes(1);
  });

  it('labels the button just Accept in the terminal phase', () => {
    const card = readyCardNode(deps(), { id: 'T-0001', title: null, track: null, repo: null, terminal: true, changes: CHANGES });
    expect(card.textContent).toContain('Accept');
    expect(card.textContent).not.toContain('Accept and merge');
    expect([...card.querySelectorAll('.tickets-ready-chip')].map((n) => n.textContent)).toEqual(['Ready to try']);
    expect(card.querySelector('.tickets-ready-title')!.textContent).toBe('(untitled)');
  });

  it('leaves missing sections out and still shows the buttons without a Changes section', () => {
    const card = readyCardNode(deps(), {
      id: 'T-0002',
      title: 'No changes yet',
      track: null,
      repo: null,
      terminal: false,
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
