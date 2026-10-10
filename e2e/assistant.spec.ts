import { test, expect, type Page } from './fixtures/drey';

/**
 * The Assistant plugin (ADR-0044 stage 7): the dock panel mounts with the
 * built-in id, the Actions Settings page (immediate-save per rule 3), and
 * a manual Action running from the editor's `⋯` menu through the plugin's
 * engine. No local model is needed: with the LLM switch off the panel
 * degrades to its quiet empty state, and a manual run reports "LLM
 * features are disabled." in the panel.
 */

const NOTE = ['---', 'title: Notiz', '---', '', 'Erster Absatz.', ''].join('\n');

/** The seeded manual Action (template + trigger), listed in the `⋯` menu. */
const ACTION_CONFIG = {
  actions: {
    templates: [
      {
        id: 'template:e2e',
        name: 'Reformat',
        prompt: 'Tidy the document.',
        resultKind: 'localized',
        builtin: null,
      },
    ],
    triggers: [
      {
        id: 'trigger:e2e',
        templateId: 'template:e2e',
        event: 'manual',
        confirm: true,
        enabled: true,
      },
    ],
  },
};

async function openNote(page: Page): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'notiz.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

test.describe('Assistant plugin', () => {
  test.use({ seedVault: { 'notiz.md': NOTE }, appConfig: ACTION_CONFIG });

  test('the assistant panel mounts in the right dock and tracks the active note', async ({
    page,
  }) => {
    await openNote(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    await expect(panel.locator('.head .title')).toHaveText('Assistant');
    // The head's chat label names the conversation (chat-first since
    // ADR-0048; the frame-header status() went away in milestone 57 -- it
    // recomputed only on shell change detection and went stale after a
    // switch) -- for a fresh vault with no chats yet: "New chat".
    await expect(panel.locator('.assistant-head .chat-label')).toHaveText('New chat');
    // LLM features are off in the e2e profile: the panel says so quietly.
    await expect(panel.locator('.assistant-thread .empty')).toHaveText(
      'LLM features are off — nothing is answered.',
    );
  });

  test('the Actions settings page is plugin-contributed and saves immediately', async ({
    page,
  }) => {
    await openNote(page);
    await page.locator('app-status-bar .settings').click();

    const actionsCategory = page.locator('.category', { hasText: 'Actions' });
    await actionsCategory.click();
    const actionsPage = page.locator('.assistant-actions-settings');
    await expect(actionsPage.locator('h3', { hasText: 'Triggers' })).toBeVisible();
    // The template library lists the built-ins. (Template names live in
    // input values, which text matchers can't see — assert on the picker's
    // option text and the built-in badges instead.)
    await expect(
      actionsPage.locator('.add-trigger option', { hasText: 'Autotag' }),
    ).toBeAttached();
    await expect(actionsPage.locator('.template .badge').first()).toHaveText('built-in');

    await page.locator('button.close[aria-label="Close settings"]').click();
  });

  test('a manual action runs from the ⋯ menu and its failure surfaces in the panel', async ({
    page,
  }) => {
    await openNote(page);

    await page.locator('app-editor .more').click();
    await page.locator('.editor-menu button', { hasText: 'Reformat' }).click();

    // LLM is off: the engine reports the run as an error outcome and the
    // panel (the plugin's own surface) shows it -- was the editor meta
    // bar's message line before the conversion.
    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    await expect(panel.locator('.assistant-panel .err')).toHaveText(
      'Reformat: LLM features are disabled.',
    );
  });
});

test.describe('Assistant plugin (disabled)', () => {
  test.use({
    seedVault: { 'notiz.md': NOTE },
    appConfig: { plugins: { disabled: ['sample', 'assistant'] } },
  });

  test('without the plugin the right dock does not render', async ({ page }) => {
    await openNote(page);
    await expect(page.locator('.assistant-panel')).toHaveCount(0);
    await expect(page.locator('app-dock[side="right"]')).toHaveCount(0);
  });
});
