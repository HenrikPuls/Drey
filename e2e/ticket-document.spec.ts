import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/drey';
import { renderVerificationSection } from '../packages/tickets-engine/src/core/verification';

/**
 * The ticket as a document (E13-6): the header strip, `## Verification` as
 * the proof widget, the Cost table and the action bar at the end of the
 * ticket's Markdown file. English throughout (the demo-vault rule).
 */

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

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const persona = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: sonnet', '  pool: [sonnet]', '  router: off', `color: '${color}'`, 'skills: []', '---', '', `Who ${title} is.`, ''].join('\n');

const verlauf = (phase: string, who: string, tokens: string, cost: number, minutes: number): string =>
  `- { phase: ${phase}, persona: ${who}, model: sonnet, tokens: ${tokens}, cost: ${cost}, dauer: ${minutes}m, ausgang: handed-over }`;

const REPORT = renderVerificationSection({
  testedAt: '2026-11-04T10:00:00Z',
  tester: 'tessa',
  environment: 'Electron 34.2.0 on win32',
  criteria: [
    { command: 'One palette after a double Ctrl+P', passed: true, screenshot: 'verify-1.png', note: null },
    { command: 'Escape closes it, the editor keeps focus', passed: true, screenshot: 'verify-2.png', note: null },
    { command: 'A slow machine (throttled CPU) still opens one', passed: true, screenshot: null, note: null },
  ],
  findings: [],
  video: 'verify-20261104-T-0118.webm',
  videoChapters: [
    { atMs: 12_000, label: 'One palette after a double Ctrl+P' },
    { atMs: 24_000, label: 'Escape closes it, the editor keeps focus' },
  ],
});

const READY = [
  '---',
  'id: T-0118',
  'title: "Palette opens twice on slow CI"',
  'repo: drey',
  'priority: high',
  'rank: 5000',
  'branch: t/T-0118',
  "entered-commit: '2026-11-04T10:05:00Z'",
  '---',
  '',
  '## Goal',
  '',
  'One Ctrl+P opens one palette, also when the machine is slow and the key repeats.',
  '',
  REPORT,
  '## Verlauf',
  '',
  verlauf('plan', 'paul', '21k', 0.31, 4),
  verlauf('build', 'ben', '88k', 0.94, 14),
  verlauf('review', 'ralf', '30k', 0.32, 5),
  verlauf('test', 'tessa', '24k', 0.27, 6),
  '',
  '## Log',
  '',
  "- '2026-11-04T10:05:00Z' tessa — test -> commit",
  '',
].join('\n');

const BUILDING = [
  '---',
  'id: T-0121',
  'title: "Outline: drag headings to reorder"',
  'repo: drey',
  'priority: normal',
  'rank: 6000',
  'branch: t/T-0121',
  "entered-build: '2026-11-04T10:30:00Z'",
  '---',
  '',
  '## Goal',
  '',
  'Drag headings in the Outline panel to reorder the note.',
  '',
  '## Verlauf',
  '',
  verlauf('plan', 'paul', '14k', 0.34, 3),
  '',
].join('\n');

const HISTORY = (id: string): string =>
  ['---', `id: ${id}`, `title: "Earlier ${id}"`, 'repo: drey', 'priority: normal', 'rank: 100', '---', '', '## Verlauf', '', verlauf('build', 'ben', '50k', 0.5, 10), ''].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#6fa58f'),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#c9a25a'),
    'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#c0706a'),
    'tickets/60-commit/T-0118.md': READY,
    'tickets/30-build/T-0121.md': BUILDING,
    'tickets/70-done/T-0090.md': HISTORY('T-0090'),
    'tickets/70-done/T-0091.md': HISTORY('T-0091'),
    'tickets/70-done/T-0092.md': HISTORY('T-0092'),
  },
});

/** A small gradient PNG (zlib + CRC by hand) so the gallery has something to show. */
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

/** Opens a ticket file through the Files tree. */
async function openFromFiles(page: Page, dir: string, file: string): Promise<void> {
  await page.getByText('tickets', { exact: true }).first().click();
  await page.getByText(dir, { exact: true }).first().click();
  await page.getByText(file, { exact: true }).first().dblclick();
}

test.describe('Ticket document (E13-6)', () => {
  test('a ticket waiting on the owner reads as a document with proof, cost and actions', async ({ page, vaultDir }) => {
    for (const [name, hue] of [['verify-1.png', 0], ['verify-2.png', 70]] as const) {
      const target = path.join(vaultDir, 'tickets', 'attachments', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, gradientPng(320, 200, hue));
    }
    await openFromFiles(page, '60-commit', 'T-0118.md');

    const strip = page.locator('app-editor .tickets-doc-strip');
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.locator('.tickets-doc-status')).toHaveText('Review');
    await expect(strip.locator('.tickets-doc-cost-fact')).toHaveText('$1.84 in total');
    await expect(strip.locator('.tickets-doc-step')).toContainText(['Plan', 'Build', 'Review', 'Test', 'Commit']);
    await expect(strip.locator('.tickets-doc-step').first()).toContainText('Paul');

    const proof = page.locator('app-editor .tickets-doc-proof');
    await expect(proof).toBeVisible();
    await expect(proof.locator('.tickets-doc-verdict')).toHaveText('3/3 green.');
    await expect(proof.locator('.tickets-doc-check')).toHaveCount(3);
    await expect(proof.locator('video')).toHaveCount(1);
    await proof.locator('img').first().evaluate(async (image: HTMLImageElement) => image.decode());
    await page.screenshot({ path: test.info().outputPath('ticket-document-top.png') });

    // CodeMirror draws block widgets near the viewport only: go to the end.
    await page.locator('app-editor .cm-scroller').first().evaluate((node: HTMLElement) => {
      node.scrollTop = node.scrollHeight;
    });
    const cost = page.locator('app-editor .tickets-doc-cost');
    await expect(cost).toBeVisible();
    await expect(cost.locator('tbody tr')).toHaveCount(4);
    await expect(cost.locator('tfoot')).toContainText('$1.84');

    const bar = page.locator('app-editor .tickets-doc-actions');
    // req-97: no Accept / Send back here, only the link to the decision card.
    await expect(bar.locator('button')).toHaveText(['Thread', 'Open Review']);
    await expect(bar.locator('.tickets-doc-decision-link')).toHaveText('Decision waiting · go to the card');
    await page.screenshot({ path: test.info().outputPath('ticket-document-ready.png') });

    // Live Preview rule: the caret in the section shows its Markdown.
    await proof.locator('.tickets-doc-check').first().click();
  });

  test('a ticket in a machine phase carries the estimate from the history', async ({ page }) => {
    await openFromFiles(page, '30-build', 'T-0121.md');
    const strip = page.locator('app-editor .tickets-doc-strip');
    await expect(strip.locator('.tickets-doc-estimate')).toContainText('$0.50', { timeout: 15_000 });
    await expect(strip.locator('.tickets-doc-cost-fact')).toHaveText('$0.34 so far');
    await page.screenshot({ path: test.info().outputPath('ticket-document-building.png') });
  });
});
