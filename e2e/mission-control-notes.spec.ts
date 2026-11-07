/**
 * req-101 — the Notes clients of Mission Control over the fake desk's Notes
 * API: the phone (390×844: Menu → Notes list → note in View → pencil → Live
 * with X and ✓ → save with `baseMtime`, the conflict view, the read-only
 * device) and the iPad (1194×834: files left, note centre, Mission Control
 * right). Prerequisite: `npm run build:mission-control`. The screenshots in
 * the test output (boards 10k, 10l, 10p, 10n, 10r) are the changelog's evidence.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';
import { NOTES_FIXTURE } from './fixtures/mission-control-fake-notes';

let desk: Awaited<ReturnType<typeof startFakeDesk>>;

test.beforeAll(async () => {
  desk = await startFakeDesk();
});

test.afterAll(async () => {
  await desk.stop();
});

test.beforeEach(() => {
  NOTES_FIXTURE.reset();
});

async function openApp(page: Page): Promise<void> {
  await page.goto(`${desk.origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell')).toBeVisible();
}

/** Types into the CodeMirror surface of the open note. */
async function typeIntoNote(page: Page, text: string): Promise<void> {
  const content = page.locator('mc-note .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test.describe('phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('list → view → pencil → Live → save, with the conflict and the cancel question', async ({ page }, testInfo) => {
    await openApp(page);
    await page.locator('mc-menu .places .row', { hasText: 'Notes' }).click();

    // 10k: the list names the vault, shows Recent and the folders.
    const list = page.locator('mc-notes');
    await expect(list.locator('.ph-vault')).toHaveText('Vault: Main vault');
    await expect(list.locator('mc-app-bar button.back')).toHaveText(/Menu/);
    await expect(list.locator('.ph-note-row', { hasText: 'Welcome' }).first()).toBeVisible();
    await expect(list.locator('.ph-folder-row', { hasText: 'ideas' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mc-phone-notes-list.png') });

    // Search.
    await list.getByRole('searchbox').fill('ship');
    await expect(list.locator('.ph-note-row')).toHaveCount(1);
    await expect(list.locator('.ph-note-row')).toContainText('Plan');
    await list.getByRole('searchbox').fill('');

    // 10l: a note opens in View with tags, the ticket link and Ask.
    await list.locator('.ph-note-row', { hasText: 'Welcome' }).first().click();
    const note = page.locator('mc-note');
    await expect(note.locator('mc-app-bar button.back')).toHaveText(/Notes/);
    await expect(note.locator('.ph-tabs')).toHaveCount(0);
    await expect(note.locator('.ph-tag')).toHaveText('#start');
    await expect(note.getByRole('button', { name: 'Ask about this note' })).toBeVisible();
    expect((await note.getByRole('button', { name: 'Edit note' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('mc-phone-note-view.png') });

    // 10p: the pencil → Live Preview, X and ✓ as icons; X asks only when the text changed.
    await note.getByRole('button', { name: 'Edit note' }).click();
    await expect(note.locator('.ph-tab.on')).toHaveText('Live');
    await expect(note.getByRole('toolbar').getByRole('button')).toHaveCount(7);
    await note.getByRole('button', { name: 'Cancel editing' }).click();
    await expect(note.locator('.sheet')).toHaveCount(0);
    await note.getByRole('button', { name: 'Edit note' }).click();
    await typeIntoNote(page, 'Added on the phone.');
    await note.getByRole('button', { name: 'Cancel editing' }).click();
    await expect(note.locator('.sheet')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mc-phone-note-discard.png') });
    await note.getByRole('button', { name: 'Keep editing' }).click();
    await page.screenshot({ path: testInfo.outputPath('mc-phone-note-edit.png') });

    // ✓ saves with the read mtime; the desk holds the text.
    await note.getByRole('button', { name: 'Save note' }).click();
    await expect(note.getByRole('button', { name: 'Edit note' })).toBeVisible();
    expect(NOTES_FIXTURE.files.get('Welcome.md')!.text).toContain('Added on the phone.');

    // A conflict shows both versions; Keep the desk's adopts the disk text.
    NOTES_FIXTURE.conflictOnce = { text: '# Welcome\n\nChanged on the desk.\n', mtime: 1_700_000_999_000 };
    await note.getByRole('button', { name: 'Edit note' }).click();
    await typeIntoNote(page, ' More.');
    await note.getByRole('button', { name: 'Save note' }).click();
    await expect(note.locator('.conflict')).toContainText('Changed on the desk.');
    await expect(note.locator('.conflict')).toContainText('More.');
    await page.screenshot({ path: testInfo.outputPath('mc-phone-note-conflict.png') });
    await note.getByRole('button', { name: "Keep the desk's" }).click();
    await expect(note.locator('.conflict')).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Edit note' })).toBeVisible();

    // Back to the list.
    await note.locator('mc-app-bar button.back').click();
    await expect(list).toBeVisible();
  });

  test('a note with a ticket links to it; Ask about this note opens the chat with the note named', async ({ page }) => {
    await openApp(page);
    await page.locator('mc-menu .places .row', { hasText: 'Notes' }).click();
    await page.locator('mc-notes .ph-folder-row', { hasText: 'ideas' }).click();
    await page.locator('mc-notes .ph-note-row', { hasText: 'Plan' }).first().click();
    const note = page.locator('mc-note');
    await expect(note.locator('.ph-linkcard')).toContainText('T-0050');
    await note.getByRole('button', { name: 'Ask about this note' }).click();
    await expect(page.locator('mc-chat')).toBeVisible();
    await expect(page.locator('mc-chat textarea')).toHaveValue('About the note ideas/Plan.md:');
  });

  test('a read-only device reads: no pencil, no mode switch, no new note', async ({ page }) => {
    NOTES_FIXTURE.readOnly = true;
    await openApp(page);
    await page.locator('mc-menu .places .row', { hasText: 'Notes' }).click();
    await expect(page.locator('mc-notes')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New note' })).toHaveCount(0);
    await page.locator('mc-notes .ph-note-row', { hasText: 'Welcome' }).first().click();
    await expect(page.locator('mc-note')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit note' })).toHaveCount(0);
    await expect(page.locator('mc-note .ph-tabs')).toHaveCount(0);
  });
});

test.describe('iPad landscape (1194×834)', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

  test('files left, the note in the centre, Mission Control right', async ({ page }, testInfo) => {
    await openApp(page);
    await page.locator('mc-shell-header .sw', { hasText: 'Notes' }).click();
    await expect(page.locator('mc-notes.pane-left')).toBeVisible();
    await expect(page.locator('mc-empty.pane-center')).toBeVisible();
    await expect(page.locator('.pane-right mc-chat')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-notes-list.png') });

    await page.locator('mc-notes .group .row', { hasText: 'Welcome' }).first().click();
    const note = page.locator('mc-note.pane-center');
    await expect(note).toBeVisible();
    await expect(page.locator('mc-notes.pane-left')).toBeVisible();
    await expect(note.locator('.mdx-seg-btn[aria-pressed="true"]')).toHaveText('View');
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-note-view.png') });

    // 10r: editing in the centre while the list and the chat stay.
    await note.getByRole('button', { name: 'Edit note' }).click();
    await typeIntoNote(page, ' iPad.');
    await expect(note.getByRole('button', { name: 'Save note' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-note-edit.png') });
    await note.getByRole('button', { name: 'Save note' }).click();
    await expect(note.getByRole('button', { name: 'Edit note' })).toBeVisible();
    expect(NOTES_FIXTURE.files.get('Welcome.md')!.text).toContain('iPad.');

    // Ask about this note: the chat pane (already mounted) adopts the line.
    await note.getByRole('button', { name: 'Ask about this note' }).click();
    await expect(page.locator('.pane-right mc-chat textarea')).toHaveValue('About the note Welcome.md:');
  });
});
