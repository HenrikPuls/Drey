import { describe, expect, it } from 'vitest';
import type { RepoRef, TicketCard, TicketMeta } from '../shared/tickets';
import { planWorktreeRemoval } from './worktree-removal';

const meta = (over: Partial<TicketMeta> = {}): TicketMeta => ({
  id: 'T-0042',
  title: 'Files vault extension',
  repo: 'drey',
  worker: null,
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
  entered: {},
  ...over,
});

const card = (over: Partial<TicketMeta> = {}): TicketCard => ({
  id: 'T-0042',
  path: 'tickets/50-build/T-0042.md',
  phase: 'build',
  meta: meta(over),
  pinned: false,
  worker: 'opencode',
  blocked: [],
  blocks: [],
  issues: [],
});

const repos = (over: Partial<RepoRef> = {}): RepoRef[] => [
  { name: 'drey', url: 'https://example/drey', branch: 'main', policy: null, path: 'E:/projects/drey', worker: null, worktrees: null, ...over },
];

describe('planWorktreeRemoval (T-0042)', () => {
  it('resolves the repo checkout for a board ticket without a run', () => {
    expect(planWorktreeRemoval({ folder: '_worktrees/T-0042', cards: [card()], repos: repos() })).toEqual({
      ok: true,
      repoPath: 'E:/projects/drey',
    });
  });

  it('accepts a target INSIDE the worktree (the menu may open on a child)', () => {
    expect(
      planWorktreeRemoval({ folder: '_worktrees/T-0042/plugins', cards: [card()], repos: repos() }),
    ).toEqual({ ok: true, repoPath: 'E:/projects/drey' });
  });

  it('refuses anything that is not a _worktrees/<ticket-id> folder', () => {
    for (const folder of ['_worktrees', '_worktrees/scratch', 'tickets/_worktrees/T-0042', 'worktrees/T-0042', 'notes']) {
      const plan = planWorktreeRemoval({ folder, cards: [card()], repos: repos() });
      expect(plan.ok).toBe(false);
    }
  });

  it('refuses a ticket that is not on the board', () => {
    const plan = planWorktreeRemoval({ folder: '_worktrees/T-9999', cards: [card()], repos: repos() });
    expect(plan).toEqual({ ok: false, error: 'T-9999 is not on the board — its worktree is not ours to remove.' });
  });

  it('refuses while a fleet run is stamped on the card', () => {
    const plan = planWorktreeRemoval({
      folder: '_worktrees/T-0042',
      cards: [card({ run: { pid: 1, 'started-at': '2026-10-29T10:00:00Z', stream: 'R-x' } })],
      repos: repos(),
    });
    expect(plan).toEqual({ ok: false, error: 'a fleet run is active for T-0042 — stop the run first.' });
  });

  it('refuses a ticket without a repo, an unknown repo, a repo without a local path', () => {
    expect(planWorktreeRemoval({ folder: '_worktrees/T-0042', cards: [card({ repo: null })], repos: repos() })).toEqual({
      ok: false,
      error: 'T-0042 names no repository.',
    });
    expect(
      planWorktreeRemoval({ folder: '_worktrees/T-0042', cards: [card({ repo: 'other' })], repos: repos() }),
    ).toEqual({ ok: false, error: 'repo "other" is not in _meta/repos.md.' });
    expect(planWorktreeRemoval({ folder: '_worktrees/T-0042', cards: [card()], repos: repos({ path: null }) })).toEqual({
      ok: false,
      error: 'repo "drey" has no local path in _meta/repos.md.',
    });
  });
});
