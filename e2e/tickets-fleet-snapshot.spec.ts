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

/**
 * D-51: the runner cannot be started (a file where the fleet root should be,
 * so its folder cannot be made). The switch still opens on the down runner's
 * Off, and the refusal names the cause instead of "The runner is not running".
 * First in the file: no runner of this home has made the fleet folder yet.
 */
test('D-51: a runner that cannot start is refused with its cause', async ({ page }) => {
  test.setTimeout(90_000);
  const fleetRoot = path.join(home, '.drey-engine', 'fleet');
  fs.mkdirSync(path.dirname(fleetRoot), { recursive: true });
  fs.writeFileSync(fleetRoot, 'not a folder');
  try {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const status = page.locator('app-status-bar');
    await status.getByText('Autopilot · Off').click();
    const popover = page.locator('.tickets-autopilot-pop');
    await popover.locator('[data-state="on"]').click();
    const alert = popover.getByRole('alert');
    await expect(alert).toContainText('The runner could not be started:', { timeout: 20_000 });
    await expect(alert).toContainText(/EEXIST|ENOTDIR/);
    await expect(alert).not.toContainText('The runner is not running');
    await expect(status.getByText('Autopilot · Off')).toBeVisible();
  } finally {
    fs.rmSync(fleetRoot, { force: true });
  }
});

/**
 * D-51: with no runner (a fresh start, and again after req-110 let it leave on
 * an Off), the item reads Off and the switch turns it On — from the status
 * item's popover and from Settings → Tickets → Autopilot "Change…".
 */
test('D-51: the Autopilot switches on with the runner down, from the popover and from Settings', async ({ page }) => {
  test.setTimeout(120_000);
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  const status = page.locator('app-status-bar');
  const popover = page.locator('.tickets-autopilot-pop');

  // From the popover: the runner is spawned by the switch itself.
  await status.getByText('Autopilot · Off').click();
  await popover.locator('[data-state="on"]').click();
  await expect(status.getByText('Autopilot · On')).toBeVisible({ timeout: 20_000 });
  await expect(popover.locator('[data-state="on"]')).toHaveAttribute('aria-checked', 'true');

  // Off: the runner leaves (nothing is live) and the open popover keeps its switch.
  await popover.locator('[data-state="off"]').click();
  await expect(status.getByText('Autopilot · Off')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => fs.existsSync(path.join(home, '.drey-engine', 'fleet', 'runner.json')), { timeout: 15_000 }).toBe(false);
  await expect(popover.locator('[data-state="off"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // From Settings: "Change…" opens the same switch; the row follows the fleet.
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'Tickets' }).first().click();
  const row = page.locator('#tset-autopilot');
  await expect(row).toHaveText('Off');
  await page.locator('app-settings button', { hasText: 'Change…' }).first().click();
  await popover.locator('[data-state="on"]').click();
  await expect(row).toHaveText('On', { timeout: 20_000 });
  await expect(status.getByText('Autopilot · On')).toBeVisible();
  await popover.locator('[data-state="off"]').click();
  await expect(row).toHaveText('Off', { timeout: 10_000 });
});

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
