import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * D-35: the fleet event over the REAL road. A real engine and a real runner in
 * a home of their own (the owner's `~/.drey-engine` is never touched), nothing
 * pushed into the plugin channel by the spec: the other specs that show runs
 * inject a `fleet-changed` snapshot themselves, which is how an event without
 * a snapshot went unseen.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfs-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;

function stopPid(file: string): void {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    if (typeof pid === 'number') {
      process.kill(pid);
    }
  } catch {
    // never started, or already gone
  }
}

// Both outlive Drey by design; kill them before the app's own teardown or that waits a minute for them.
test.afterEach(() => {
  stopPid(path.join(home, '.drey-engine', 'fleet', 'runner.json'));
  stopPid(path.join(home, '.drey-engine', 'engine.lock'));
});

test.afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // the processes hold files open for a moment after the kill; a leftover temp dir is harmless
  }
});

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: build, title: Build, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

test.use({ seedVault: { 'tickets/_meta/pipeline.md': PIPELINE } });

test('the Autopilot item and popover follow the runner across fleet events', async ({ page }) => {
  test.setTimeout(120_000);
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  const status = page.locator('app-status-bar');

  // The runner comes up on this click and its state change is a fleet event.
  await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).filter({ visible: true }).locator('.head').hover();
  await page.locator('button[aria-label="Run the chain"]').filter({ visible: true }).first().click({ timeout: 30_000 });
  await expect(status.getByText('Autopilot · On')).toBeVisible({ timeout: 20_000 });
  // Another poll round must not take it away again.
  await page.waitForTimeout(6_000);
  await expect(status.getByText('Autopilot · On')).toBeVisible();

  await status.getByText('Autopilot · On').click();
  const popover = page.locator('.tickets-autopilot-pop');
  await popover.locator('[data-state="paused"]').click();
  await expect(status.getByText('Autopilot · Paused')).toBeVisible({ timeout: 10_000 });
  // The popover keeps its segments through the event.
  await page.waitForTimeout(3_000);
  await expect(popover.locator('[data-state="paused"]')).toHaveAttribute('aria-checked', 'true');

  await popover.locator('[data-state="off"]').click();
  await expect(status.getByText('Autopilot · Off')).toBeVisible({ timeout: 10_000 });
  await expect(popover.locator('[data-state="off"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});
