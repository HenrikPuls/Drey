import { test, expect } from './fixtures/drey';

/**
 * The Work row's menu (req-70, req-75 W1): the moves first — queue an
 * idea or take it back, any phase by name — then the runs (finished ones
 * behind one "Past runs ›" submenu), the maintenance rows behind "More ›"
 * with only the claim rows that apply, arrow keys through the rows. The
 * fleet runner does not run under e2e, so the finished runs arrive as a
 * pushed `fleet-changed` snapshot.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default }',
  '  - { id: build, title: Build, handover: agent build-default, claim: true }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string, phase: string, claimedBy: string | null): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    `branch: t/${id}`,
    `entered-inbox: '2026-10-17T14:32:00Z'`,
    `entered-${phase}: '2026-10-18T09:00:00Z'`,
    ...(claimedBy === null ? [] : [`claimed-by: ${claimedBy}`, `claimed-at: '2026-10-18T09:00:00Z'`]),
    '---',
    '',
    '## Description',
    '',
    'It should work.',
    '',
    '## Log',
    '',
  ].join('\n');
}

function finishedRun(id: string, column: string, state: string, startedAt: string): Record<string, unknown> {
  return {
    id,
    ticketId: 'T-0051',
    provider: 'opencode',
    column,
    state,
    pid: null,
    startedAt,
    endedAt: startedAt,
    sessionRef: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: null,
    lastActivity: startedAt,
  };
}

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/10-inbox/T-0050.md': ticket('T-0050', 'An idea', 'inbox', null),
    'tickets/20-plan/T-0051.md': ticket('T-0051', 'With history', 'plan', null),
    'tickets/30-build/T-0052.md': ticket('T-0052', 'Mine', 'build', 'owner@desk'),
    'tickets/30-build/T-0053.md': ticket('T-0053', 'Theirs', 'build', 'opencode@desk'),
  },
});

const menu = '.tickets-menu:not(.tickets-submenu)';

test.describe('Work row menu (req-70, req-75 W1)', () => {
  test('past runs sit behind one submenu row', async ({ page, electronApp }, testInfo) => {
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    const row = page.locator('.work-row[data-id="T-0051"]').filter({ visible: true });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await electronApp.evaluate(
      ({ BrowserWindow }, data) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('plugin:event', data);
        }
      },
      {
        pluginId: 'tickets',
        event: 'fleet-changed',
        data: {
          runs: [
            finishedRun('r1', 'plan', 'done', '2026-10-30T04:52:00Z'),
            finishedRun('r2', 'commit', 'failed', '2026-10-29T09:48:00Z'),
            finishedRun('r3', 'build', 'stopped', '2026-10-19T22:57:00Z'),
          ],
          chain: null,
        },
      },
    );

    await row.click({ button: 'right' });
    await expect(page.locator(menu)).toBeVisible();
    const trigger = page.locator(`${menu} .tickets-menu-item.has-sub`, { hasText: 'Past runs' });
    await expect(trigger).toHaveText(/Past runs \(3\)/);

    await trigger.hover();
    const sub = page.locator('.tickets-submenu');
    await expect(sub).toBeVisible();
    await expect(sub.locator('.tickets-menu-item')).toHaveCount(3);
    await expect(sub.locator('.tickets-menu-item').first()).toContainText('plan');
    await expect(sub.locator('.tickets-menu-item').first()).toContainText('10-30 04:52');
    await page.screenshot({ path: testInfo.outputPath('row-menu-submenu.png') });

    // Keyboard: ArrowLeft goes back to the row, Escape closes everything.
    await sub.locator('.tickets-menu-item').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(sub.locator('.tickets-menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(sub).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(sub.locator('.tickets-menu-item').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.tickets-menu')).toHaveCount(0);
  });

  test('an idea is queued for the fleet, a waiting one goes back', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    const rows = page.locator(`${menu} .tickets-menu-item`);

    const idea = page.locator('.work-row[data-id="T-0050"]').filter({ visible: true });
    await expect(idea).toBeVisible({ timeout: 15_000 });
    await idea.click({ button: 'right' });
    await expect(rows.filter({ hasText: 'Queue for the fleet' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Back to ideas' })).toHaveCount(0);
    // Move to › lists every other phase by name.
    await rows.filter({ hasText: 'Move to' }).hover();
    await expect(page.locator('.tickets-submenu .tickets-menu-item')).toHaveText(['Plan', 'Build', 'Done']);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Plan pulls from the inbox here, so a planned ticket without a run can go back.
    const planned = page.locator('.work-row[data-id="T-0051"]').filter({ visible: true });
    await planned.click({ button: 'right' });
    await expect(rows.filter({ hasText: 'Back to ideas' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Queue for the fleet' })).toHaveCount(0);
  });

  test('only the claim rows that apply, behind More', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    const more = page.locator(`${menu} .tickets-menu-item.has-sub`, { hasText: 'More' });
    const sub = page.locator('.tickets-submenu .tickets-menu-item');

    const mine = page.locator('.work-row[data-id="T-0052"]').filter({ visible: true });
    await expect(mine).toBeVisible({ timeout: 15_000 });
    await mine.click({ button: 'right' });
    await more.hover();
    await expect(sub.filter({ hasText: 'Release claim' })).toHaveCount(1);
    await expect(sub.filter({ hasText: 'Take over claim' })).toHaveCount(0);
    await expect(sub.filter({ hasText: /^Claim$/ })).toHaveCount(0);
    await expect(page.locator(`${menu} .tickets-menu-item`, { hasText: 'Past runs' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    const theirs = page.locator('.work-row[data-id="T-0053"]').filter({ visible: true });
    await theirs.click({ button: 'right' });
    await more.hover();
    await expect(sub.filter({ hasText: 'Take over claim' })).toHaveCount(1);
    await expect(sub.filter({ hasText: 'Release claim' })).toHaveCount(1);
  });
});
