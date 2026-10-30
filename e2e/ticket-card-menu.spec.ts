import { test, expect } from './fixtures/drey';

/**
 * The card context menu, regrouped (req-70): finished runs behind one
 * "Past runs ›" submenu, only the claim rows that apply, arrow keys
 * through the rows. The fleet runner does not run under e2e, so the
 * finished runs arrive as a pushed `fleet-changed` snapshot.
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
    'rank: 5000',
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
    'tickets/_meta/order.md': '# Column order pins\n',
    'tickets/20-plan/T-0051.md': ticket('T-0051', 'With history', 'plan', null),
    'tickets/30-build/T-0052.md': ticket('T-0052', 'Mine', 'build', 'owner@desk'),
    'tickets/30-build/T-0053.md': ticket('T-0053', 'Theirs', 'build', 'opencode@desk'),
  },
});

test.describe('Ticket card menu (req-70)', () => {
  test('past runs sit behind one submenu row', async ({ page, electronApp }, testInfo) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const card = page.locator('.tickets-card[data-id="T-0051"]').filter({ visible: true });
    await expect(card).toBeVisible({ timeout: 15_000 });

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

    await card.click({ button: 'right' });
    const menu = page.locator('.tickets-menu:not(.tickets-submenu)');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.tickets-menu-item', { hasText: /^Past run —/ })).toHaveCount(0);
    const trigger = menu.locator('.tickets-menu-item.has-sub');
    await expect(trigger).toHaveText(/Past runs \(3\)/);
    await expect(menu.locator('.tickets-menu-item', { hasText: 'Open work folder in terminal' })).toHaveText(
      'Open work folder in terminal',
    );
    // Unclaimed: the one claim row is "Claim".
    await expect(menu.locator('.tickets-menu-item', { hasText: /^Claim$/ })).toHaveCount(1);
    await expect(menu.locator('.tickets-menu-item', { hasText: 'Release claim' })).toHaveCount(0);

    await trigger.hover();
    const sub = page.locator('.tickets-submenu');
    await expect(sub).toBeVisible();
    await expect(sub.locator('.tickets-menu-item')).toHaveCount(3);
    await expect(sub.locator('.tickets-menu-item').first()).toContainText('plan');
    await expect(sub.locator('.tickets-menu-item').first()).toContainText('10-30 04:52');
    await page.screenshot({ path: testInfo.outputPath('card-menu-submenu.png') });

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

  test('only the claim rows that apply', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const rows = page.locator('.tickets-menu .tickets-menu-item');

    const mine = page.locator('.tickets-card[data-id="T-0052"]').filter({ visible: true });
    await expect(mine).toBeVisible({ timeout: 15_000 });
    await mine.click({ button: 'right' });
    await expect(rows.filter({ hasText: 'Release claim' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Take over claim' })).toHaveCount(0);
    await expect(rows.filter({ hasText: /^Claim$/ })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Past runs' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const theirs = page.locator('.tickets-card[data-id="T-0053"]').filter({ visible: true });
    await theirs.click({ button: 'right' });
    await expect(rows.filter({ hasText: 'Take over claim' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Release claim' })).toHaveCount(1);
  });
});
