/**
 * Wave row 4.6: stands the built Mission Control in the state each iPad board
 * draws and writes the screenshot to test-results/fidelity/<Board>.png, for
 * boards/compare.html. 1194×834 and 834×1194 at device scale factor 1, touch,
 * with the iPad's safe areas (24 / 20) the boards reserve, emulated over CDP so
 * the app's real env(safe-area-inset-*) rules are what is measured. The clock
 * is fixed so the sample's times read as on the boards. Prerequisite:
 * npm run build:mission-control.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';
import { PAD_FLOW_130_DRAFT, PAD_SHAPE_QUESTION } from './fixtures/mission-control-fake-boards';

let desk: Awaited<ReturnType<typeof startFakeDesk>>;
const OUT = process.env['FID_OUT'] ?? 'test-results/fidelity';

test.beforeAll(async () => {
  desk = await startFakeDesk({ boards: true, pad: true });
});
test.afterAll(async () => {
  await desk.stop();
});

async function open(page: Page, origin = desk.origin): Promise<void> {
  await page.clock.setFixedTime(new Date(2026, 10, 7, 14, 10));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, left: 0, bottom: 20, right: 0 } });
  await page.goto(`${origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell.ipad')).toBeVisible();
  await settle(page);
}

/** Stands the needs list in the board's state: the desk's own answer, patched. */
const needsOf = (page: Page, patch: (needs: Record<string, unknown>[]) => unknown[]) =>
  page.route('**/api/needs', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: patch((await response.json()) as Record<string, unknown>[]) });
  });
const settle = (page: Page) => page.waitForTimeout(350);
const shot = async (page: Page, board: string) => {
  await settle(page);
  await page.screenshot({ path: `${OUT}/${board}.png` });
};
const area = (page: Page, name: string) => page.locator('mc-shell-header .sw', { hasText: name }).click();
/** The conversation of 10e: a session opened from the chats, then back to the ticket. */
const session = async (page: Page, title: string, pickFirst = true) => {
  await ticket(page, title);
  await page.locator('mc-ticket .ph-thread').click();
  if (pickFirst) {
    await page.locator('mc-pad-chats .row').first().click();
  }
  await settle(page);
  await page.locator('mc-chat mc-app-bar button.back').click();
  await settle(page);
};
/** A shape session on T-0130 (5b): Thread finds it, the Assistant shows it. */
const SHAPE_FILE = 'tickets/_meta/chat/shape-t-0130.md';
const shapeSession = async (page: Page, messages: readonly Record<string, unknown>[]) => {
  const meta = { file: SHAPE_FILE, title: 'Shape T-0130', ticket: 'T-0130', createdAt: new Date(2026, 10, 7, 14, 0).toISOString(), updatedAt: new Date(2026, 10, 7, 14, 2).toISOString(), pending: 0 };
  await page.route('**/api/chat/sessions', async (route) => {
    const reply = await route.fetch();
    await route.fulfill({ response: reply, json: [meta, ...((await reply.json()) as unknown[])] });
  });
  await page.route(`**/api/chat/sessions/${encodeURIComponent(SHAPE_FILE)}`, (route) => route.fulfill({ json: { ...meta, messages, proposals: [] } }));
};
const ticket = async (page: Page, title: string) => {
  await page.locator('mc-work .ph-trow', { hasText: title }).first().click();
  await expect(page.locator('.ticket-layer.open')).toBeVisible();
  await settle(page);
};

test.describe('landscape', () => {
  test.use({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 1, hasTouch: true, locale: 'en-GB' });

  test('10e work', async ({ page }) => {
    await open(page);
    await session(page, 'Outline: drag headings to reorder');
    await page.getByRole('radio', { name: /Move the whole section/ }).click();
    await shot(page, 'MPadWork');
  });

  test('10q ready', async ({ page }) => {
    await open(page);
    await ticket(page, 'Palette opens twice on slow CI');
    await page.getByRole('radio', { name: /Accept and merge/ }).click();
    await shot(page, 'MPadReady');
  });

  test('5b shape', async ({ page }) => {
    await needsOf(page, (needs) => needs.map((need) => (need['ticketId'] === 'T-0130' ? PAD_SHAPE_QUESTION : need)));
    await shapeSession(page, [
      { role: 'mission', text: 'Paul drafted Goal, Decisions and Constraints in the ticket. Edit it right there; your changes go with your next message.', at: new Date(2026, 10, 7, 14, 0).toISOString(), thought: null },
      { role: 'mission', text: 'I read your change to the second decision. That keeps the capture window simple. One thing is open: how much of this is one ticket?', at: new Date(2026, 10, 7, 14, 2).toISOString(), thought: null },
    ]);
    await open(page);
    await session(page, 'Voice capture for tickets', false);
    await page.getByRole('radio', { name: /^3 parts/ }).click();
    await shot(page, 'PadShape');
  });

  test('5c plan', async ({ page }) => {
    await needsOf(page, (needs) => needs.map((need) => (need['ticketId'] === 'T-0130' ? { kind: 'checkpoint', phase: 'plan', ticketId: 'T-0130', title: 'Voice capture for tickets', summary: 'Plan to accept.' } : need)));
    await open(page);
    await page.locator('mc-work .ph-trow', { hasText: 'Voice capture for tickets' }).first().click();
    await expect(page.locator('mc-plan-approve .pd-wide-bar')).toBeVisible();
    await page.getByRole('radio', { name: /^Accept plan/ }).click();
    await shot(page, 'PadPlan');
  });

  test('5i flow', async ({ page }) => {
    await needsOf(page, (needs) => needs.map((need) => (need['ticketId'] === 'T-0130' ? { kind: 'checkpoint', phase: 'plan', ticketId: 'T-0130', title: 'Voice capture for tickets', summary: 'Plan to accept.' } : need)));
    await page.route('**/api/tickets/T-0130/flow-draft', (route) => route.fulfill({ json: PAD_FLOW_130_DRAFT }));
    await open(page);
    await page.locator('mc-work .ph-trow', { hasText: 'Voice capture for tickets' }).first().click();
    await expect(page.locator('mc-plan-approve .pd-wide-bar')).toBeVisible();
    await page.locator('mc-plan-approve').getByRole('button', { name: /Change flow/ }).click();
    await expect(page.locator('mc-flow-editor .pd-flow')).toBeVisible();
    await expect(page.locator('mc-flow-editor .pd-fgate')).toHaveCount(4);
    await page.locator('mc-flow-editor #pd-flow-ask').fill('Add a security pass for the command parser');
    await page.locator('mc-flow-editor').getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('mc-flow-editor .pd-fpaul')).toBeVisible();
    await page.locator('mc-flow-editor .pd-fgate', { hasText: 'Security' }).click();
    await expect(page.locator('mc-flow-editor .pd-fcard')).toBeVisible();
    await shot(page, 'PadFlow');
  });

  test('5d crew', async ({ page }) => {
    await open(page);
    await area(page, 'Crew');
    await settle(page);
    await page.locator('mc-team .pd-card', { hasText: 'Tessa' }).getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator('mc-team .pd-card', { hasText: 'Paul' }).locator('.pd-head').click();
    await page.locator('mc-persona-detail').getByRole('tab', { name: 'Setup' }).click();
    await expect(page.locator('mc-persona-detail .pd-pool')).toHaveCount(2);
    await shot(page, 'PadTeam');
  });

  test('5f settings', async ({ page }) => {
    await open(page);
    await page.locator('mc-shell-header').getByRole('button', { name: 'Settings' }).click();
    await shot(page, 'PadSettings');
  });

  test('5h review', async ({ page }) => {
    await needsOf(page, (needs) =>
      needs.map((need) => (need['ticketId'] === 'T-0121' ? { kind: 'checkpoint', phase: 'review', ticketId: 'T-0121', title: 'Outline: drag headings to reorder', summary: 'Ready for your review.' } : need)),
    );
    await open(page);
    await ticket(page, 'Outline: drag headings to reorder');
    await page.locator('mc-ticket').getByRole('button', { name: 'More', exact: true }).click();
    await page.locator('mc-ticket .ph-sheet-row', { hasText: /^Review$/ }).click();
    await expect(page.locator('mc-ticket .pd-rev')).toBeVisible();
    await settle(page);
    await page.locator('mc-ticket .pd-rtile', { hasText: 'drag.ts' }).first().getByRole('checkbox').click();
    await page.locator('mc-ticket .pd-rrow', { hasText: 'if (range === null)' }).click();
    await page.locator('mc-ticket #pd-draft-note').fill('What happens with an empty selection? I would expect nothing to move.');
    await page.locator('mc-ticket .pd-rcard').getByRole('button', { name: 'Add comment' }).click();
    await page.locator('mc-ticket .pd-rscroll').evaluate((el) => { el.scrollTop = 0; });
    await shot(page, 'PadReview');
  });

  test('10f chat', async ({ page }) => {
    await open(page);
    await ticket(page, 'Outline: drag headings to reorder');
    await page.locator('mc-ticket .ph-thread').click();
    await page.locator('mc-pad-chats .row').first().click();
    await settle(page);
    await page.getByRole('radio', { name: /Move the whole section/ }).click();
    await shot(page, 'MPadChat');
  });

  test('10n notes, 10r edit', async ({ page }) => {
    await open(page);
    await area(page, 'Notes');
    await settle(page);
    await page.locator('mc-notes').getByText('Outline ideas').first().click();
    await shot(page, 'MPadNotes');
    await page.locator('mc-note button.edit').click();
    await settle(page);
    await page.locator('mc-note .cm-line', { hasText: 'Open points' }).click({ position: { x: 120, y: 10 } });
    await page.keyboard.press('End');
    await shot(page, 'MPadNotesEdit');
  });

  test('10t chip', async ({ page }) => {
    const own = await startFakeDesk({ boards: true, pad: true });
    await open(page, own.origin);
    await page.locator('mc-autopilot-chip button').first().click();
    await page.getByRole('radio', { name: /^Paused/ }).click();
    await expect(page.getByRole('radio', { name: /^Paused/ })).toHaveAttribute('aria-checked', 'true');
    await page.locator('mc-autopilot-panel input[type="time"]').fill('18:00');
    await shot(page, 'Autopilot-ipad');
    await own.stop();
  });
});

test.describe('portrait', () => {
  test.use({ viewport: { width: 834, height: 1194 }, deviceScaleFactor: 1, hasTouch: true, locale: 'en-GB' });

  test('10s portrait', async ({ page }) => {
    await open(page);
    await ticket(page, 'Outline: drag headings to reorder');
    await shot(page, 'MPadPortrait');
  });
});
