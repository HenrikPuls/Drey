import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/drey';
import { renderVerificationSection } from '../packages/tickets-engine/src/core/verification';

// A home of its own, so the plugin spawns an engine for the seeded vault
// instead of adopting the owner's live one (see desk-board-team.spec.ts).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

function stopEngine(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'engine.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
}

/**
 * The Review tab (E13-7): the proof above, the ticket branch's diff below,
 * line comments that become the ticket's `### Review feedback` on Send
 * back. The work repository is a throwaway git repo with a branch and a
 * worktree where the engine looks for it (`worktrees:` in repos.md).
 */

const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-code-'));
const repoDir = path.join(codeRoot, 'drey');
const worktreeBase = path.join(codeRoot, 'wt');

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'ignore' });
};

function buildCodeRepo(): void {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-b', 'main');
  fs.mkdirSync(path.join(repoDir, 'src'));
  const before = [
    'export function onDrop(event: DragEvent, tree: OutlineTree): void {',
    '  const target = tree.nodeAt(event.clientY);',
    '  tree.moveHeading(source, target);',
    '  view.dispatch({ effects: refresh.of(null) });',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'drag.ts'), before);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Drey\n');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'base');
  fs.mkdirSync(worktreeBase, { recursive: true });
  git(repoDir, 'worktree', 'add', '-b', 't/T-0118', path.join(worktreeBase, 'T-0118'), 'main');
  const wt = path.join(worktreeBase, 'T-0118');
  const after = [
    'export function onDrop(event: DragEvent, tree: OutlineTree): void {',
    '  const target = tree.nodeAt(event.clientY);',
    '  const range = tree.sectionRange(source);',
    '  if (range === null) { return; }',
    '  tree.moveRange(range, target, { withBody: !event.altKey });',
    '  view.dispatch({ effects: refresh.of(null) });',
    '}',
    'export function sectionDepth(node: OutlineNode): number {',
    '  return node.level - tree.minLevel;',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(wt, 'src', 'drag.ts'), after);
  fs.writeFileSync(path.join(wt, 'src', 'drag.spec.ts'), "import { it } from 'vitest';\nit('moves a section', () => undefined);\n");
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'drag sections');
}
buildCodeRepo();

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: review, title: Review, handover: agent review-default, persona: ralf }',
  '  - { id: test, title: Test, handover: agent test-default, persona: tessa }',
  '  - { id: commit, title: Commit, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = [
  '---',
  'repos:',
  '  drey:',
  '    url: https://example.invalid/drey.git',
  '    branch: main',
  `    path: ${JSON.stringify(repoDir)}`,
  `    worktrees: ${JSON.stringify(worktreeBase)}`,
  '---',
  '',
].join('\n');

const persona = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: sonnet', '  pool: [sonnet]', '  router: off', `color: '${color}'`, 'skills: []', '---', '', `Who ${title} is.`, ''].join('\n');

const REPORT = renderVerificationSection({
  testedAt: '2026-11-04T10:00:00Z',
  tester: 'tessa',
  environment: 'Electron 34.2.0 on win32',
  criteria: [
    { command: 'Drag a heading', passed: true, screenshot: 'verify-1.png', note: null },
    { command: 'Undo once', passed: true, screenshot: 'verify-2.png', note: null },
    { command: 'Last heading', passed: true, screenshot: null, note: null },
  ],
  findings: [],
  video: null,
  videoChapters: [],
});

const READY = [
  '---',
  'id: T-0118',
  'title: "Outline: drag headings to reorder"',
  'repo: drey',
  'priority: high',
  'rank: 5000',
  'branch: t/T-0118',
  "entered-commit: '2026-11-04T10:05:00Z'",
  '---',
  '',
  '## Goal',
  '',
  'Drag a heading in the Outline panel and the section moves with it.',
  '',
  REPORT,
  '## Log',
  '',
  "- '2026-11-04T10:05:00Z' tessa — test -> commit",
  '',
].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#6fa58f'),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#c9a25a'),
    'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#c0706a'),
    'tickets/60-commit/T-0118.md': READY,
  },
});

test.afterAll(() => {
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
  fs.rmSync(codeRoot, { recursive: true, force: true });
});

/** A small gradient PNG so the proof gallery has something to show. */
function gradientPng(width: number, height: number, hue: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.min(255, 40 + hue + Math.round((x / width) * 120));
      raw[row + 2 + x * 3] = Math.min(255, 60 + Math.round((y / height) * 140));
      raw[row + 3 + x * 3] = 110;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function openFromFiles(page: Page, dir: string, file: string): Promise<void> {
  await page.getByText('tickets', { exact: true }).first().click();
  await page.getByText(dir, { exact: true }).first().click();
  await page.getByText(file, { exact: true }).first().dblclick();
}

function findTicketFile(dir: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      const hit = findTicketFile(full);
      if (hit !== null) {
        return hit;
      }
    } else if (entry.name === 'T-0118.md') {
      return full;
    }
  }
  return null;
}

test.describe('Review tab (E13-7)', () => {
  test('Open Review shows proof and diff; line comments leave as Handover feedback', async ({ page, vaultDir }) => {
    for (const [name, hue] of [['verify-1.png', 0], ['verify-2.png', 70]] as const) {
      const target = path.join(vaultDir, 'tickets', 'attachments', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, gradientPng(320, 200, hue));
    }
    await openFromFiles(page, '60-commit', 'T-0118.md');
    await page.locator('app-editor .cm-scroller').first().evaluate((node: HTMLElement) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.locator('app-editor .tickets-doc-actions').getByRole('button', { name: 'Open Review' }).click();

    const review = page.locator('.tickets-review');
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(review.locator('.tickets-doc-verdict')).toHaveText('3/3 green.');
    await expect(review.locator('.tickets-review-summary')).toHaveText('2 files · 0 of 2 viewed', { timeout: 15_000 });
    await expect(review.locator('.tickets-review-chip')).toHaveCount(2);
    await review.locator('.tickets-review-chip', { hasText: 'src/drag.ts' }).click();
    await expect(review.locator('.tickets-review-row.is-add')).not.toHaveCount(0);
    await review.locator('img').first().evaluate(async (image: HTMLImageElement) => image.decode());
    await page.screenshot({ path: test.info().outputPath('review-top.png') });

    // Two line comments, one of them a range.
    const lineButton = (n: string) => review.locator('.tickets-review-add', { hasText: new RegExp(`^${n}$`) });
    await lineButton('4').click();
    await review.locator('.tickets-review-input').fill('What happens with an empty selection? I would expect nothing to move.');
    await review.getByRole('button', { name: 'Add comment' }).click();
    await lineButton('8').click();
    await lineButton('10').click({ modifiers: ['Shift'] });
    await review.locator('.tickets-review-input').fill('Name this after what it returns, not how it is computed.');
    await review.getByRole('button', { name: 'Add comment' }).click();
    await expect(review.locator('.tickets-review-comment')).toHaveCount(2);

    await review.locator('.tickets-review-viewed input').check();
    await expect(review.locator('.tickets-review-summary')).toHaveText('2 files · 1 of 2 viewed');
    await review.getByRole('button', { name: 'Whole file' }).click();
    await expect(review.locator('.tickets-review-row.is-context')).not.toHaveCount(0);
    await review.getByRole('button', { name: 'Changes' }).click();

    const send = review.locator('.tickets-review-footer').getByRole('button', { name: 'Send back with 2 comments' });
    await expect(send).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('review-comments.png') });
    await review.locator('.tickets-review-scroll').evaluate((node: HTMLElement) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.screenshot({ path: test.info().outputPath('review-diff.png') });

    await send.click();
    await expect(review.locator('.tickets-review-note')).toContainText('Sent back', { timeout: 15_000 });

    // The ticket file sits in an earlier phase now, with the structured feedback in its Handover.
    const found = findTicketFile(path.join(vaultDir, 'tickets'));
    expect(found).not.toBeNull();
    expect(found).not.toContain('60-commit');
    const text = fs.readFileSync(found!, 'utf8');
    expect(text).toContain('## Handover');
    expect(text).toContain('### Review feedback');
    expect(text).toContain('`src/drag.ts:4` — What happens with an empty selection? I would expect nothing to move.');
    expect(text).toContain('`src/drag.ts:8-10` — Name this after what it returns, not how it is computed.');
    // The branch is no registered vault here: Open in editor opens a copy of the file.
    await review.getByRole('button', { name: 'Open in editor' }).click();
    await expect(page.getByText(/^(src\/)?drag\.ts$/).filter({ visible: true }).first()).toBeVisible();
    stopEngine();
  });
});
