import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { phaseWithoutPoolKeys, type PipelinePhase, type RepoRef, type TicketCard } from '../../shared/tickets';
import { parseRepos } from '../ticket-board';
import { composeRunRequest } from './request';
import {
  isUnderAnyBase,
  legacyWorktreeBase,
  WORKTREES_DIR,
  worktreeBaseFor,
  worktreeFolderName,
  worktreePathFor,
} from './worktree-home';

/**
 * The worktree home rule (T-0044, ADR-0080): base resolution (default +
 * per-repo override), folder naming, the legacy-base helper and the
 * under-base predicates — plus the two carriers (repos.md parsing, the
 * composed run request and its brief) that make the rule live.
 */

const repo = (over: Partial<RepoRef> = {}): RepoRef => ({
  name: 'drey',
  url: 'https://example.test/drey.git',
  branch: 'main',
  policy: null,
  path: 'W:/drey',
  worker: null,
  worktrees: null,
  ...over,
});

describe('worktreeBaseFor', () => {
  it('defaults to <ticketsRepo>/_worktrees at the repo root', () => {
    expect(worktreeBaseFor('V:/tickets', repo())).toBe(path.join('V:/tickets', WORKTREES_DIR));
    expect(WORKTREES_DIR).toBe('_worktrees');
  });

  it('a repos.md worktrees: override names the base, absolute wins as-is', () => {
    expect(worktreeBaseFor('V:/tickets', repo({ worktrees: 'E:/checkouts' }))).toBe(
      path.resolve('E:/checkouts'),
    );
  });

  it('a relative override resolves against the tickets repo root', () => {
    expect(worktreeBaseFor('V:/tickets', repo({ worktrees: 'fleet-checkouts' }))).toBe(
      path.resolve('V:/tickets', 'fleet-checkouts'),
    );
  });

  it('a blank override reads as unset', () => {
    expect(worktreeBaseFor('V:/tickets', repo({ worktrees: '  ' }))).toBe(
      path.join('V:/tickets', WORKTREES_DIR),
    );
  });
});

describe('worktree naming', () => {
  it('the folder is the bare ticket id', () => {
    expect(worktreeFolderName('T-0044')).toBe('T-0044');
    expect(worktreePathFor('V:/tickets', repo(), 'T-0044')).toBe(
      path.join('V:/tickets', '_worktrees', 'T-0044'),
    );
  });

  it('an override base carries the same ticket folder', () => {
    expect(worktreePathFor('V:/tickets', repo({ worktrees: 'E:/checkouts' }), 'T-0044')).toBe(
      path.join(path.resolve('E:/checkouts'), 'T-0044'),
    );
  });

  it('the legacy base is <fleetRoot>/worktrees', () => {
    expect(legacyWorktreeBase('F:/fleet')).toBe(path.join('F:/fleet', 'worktrees'));
  });
});

describe('isUnderAnyBase', () => {
  const bases = ['F:/fleet/worktrees', 'V:/tickets/_worktrees'];
  it('matches the base itself and paths under it', () => {
    expect(isUnderAnyBase('F:/fleet/worktrees', bases)).toBe(true);
    expect(isUnderAnyBase(path.join('F:/fleet/worktrees', 'drey-T-0001'), bases)).toBe(true);
  });

  it('rejects paths beside or outside the bases', () => {
    expect(isUnderAnyBase('F:/fleet/worktrees-other/x', bases)).toBe(false);
    expect(isUnderAnyBase('V:/tickets/_worktrees2/x', bases)).toBe(false);
    expect(isUnderAnyBase('E:/elsewhere/T-0001', bases)).toBe(false);
  });

  it('compares case-folded on win32 whatever the slash direction', () => {
    const folded = path.resolve('F:/fleet/worktrees/drey-T-0001').replaceAll('\\', '/');
    expect(isUnderAnyBase(folded.toUpperCase(), bases)).toBe(process.platform === 'win32');
    expect(isUnderAnyBase(folded, bases)).toBe(true);
  });
});

describe('parseRepos: the worktrees: key', () => {
  it('reads the override, defaults to null', () => {
    const { repos, error } = parseRepos(
      [
        '---',
        'repos:',
        '  drey:',
        '    url: https://example.test/drey.git',
        '    worktrees: E:/checkouts',
        '  plain:',
        '    url: https://example.test/plain.git',
        '---',
      ].join('\n'),
    );
    expect(error).toBeNull();
    expect(repos[0]).toMatchObject({ name: 'drey', worktrees: 'E:/checkouts' });
    expect(repos[1]).toMatchObject({ name: 'plain', worktrees: null });
  });

  it('a blank value reads as null', () => {
    const { repos } = parseRepos('---\nrepos:\n  x:\n    url: u\n    worktrees: "  "\n---\n');
    expect(repos[0]).toMatchObject({ name: 'x', worktrees: null });
  });
});

describe('composeRunRequest carries the home rule', () => {
  const phase = (id: string): PipelinePhase =>
    phaseWithoutPoolKeys({ id, title: id, wip: null, claim: false, handover: 'manual' });

  const card: TicketCard = {
    id: 'T-0001',
    path: 'tickets/prioritized/T-0001.md',
    phase: 'prioritized',
    meta: {
      id: 'T-0001',
      title: 'Add the thing',
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
    },
    pinned: false,
    worker: 'opencode',
    blocked: [],
    blocks: [],
    issues: [],
  };

  const ticketText = [
    '---',
    'id: T-0001',
    '---',
    '',
    '## Description',
    '',
    'It should work.',
    '',
    '### Acceptance criteria',
    '',
    '- [ ] `npm run verify:unit` — exits 0',
    '',
  ].join('\n');

  const compose = (over: Partial<RepoRef> = {}) =>
    composeRunRequest({
      card,
      ticketText,
      vaultPath: 'V:/tickets',
      workingPhase: phase('prioritized'),
      nextPhaseId: 'plan',
      nextPhaseDir: null,
      pushRemote: null,
      nextPhaseClaims: false,
      repo: repo(over),
      promptText: null,
      defaultWorker: 'opencode',
      permissionMode: 'accept-edits',
      gitPath: '',
      workerChoice: null,
      repoInstructions: null,
      diffStat: null,
      gateFailure: null,
    });

  it('the request and the brief name the absolute worktree path', () => {
    const result = compose();
    if (!result.ok) {
      throw new Error(result.error);
    }
    const expected = path.join('V:/tickets', '_worktrees', 'T-0001');
    expect(result.request.worktreePath).toBe(expected);
    expect(result.request.instruction).toContain(`Work checkout: ${expected}`);
  });

  it('a repos.md override moves both the request and the brief', () => {
    const result = compose({ worktrees: 'E:/checkouts' });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const expected = path.join(path.resolve('E:/checkouts'), 'T-0001');
    expect(result.request.worktreePath).toBe(expected);
    expect(result.request.instruction).toContain(`Work checkout: ${expected}`);
  });
});
