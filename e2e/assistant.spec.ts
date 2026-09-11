import { test, expect, type Page } from './fixtures/drey';

/**
 * The Assistant plugin (ADR-0044 stage 7): the dock panel mounts with the
 * built-in id, the two plugin Settings pages (Assistant, Actions —
 * immediate-save per rule 3), and a manual Action running from the editor's
 * `⋯` menu through the plugin's engine. No local model is needed: with the
 * LLM switch off the panel degrades to its quiet empty state, and a manual
 * run reports "LLM features are disabled." in the panel.
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
    // The header status follows the active note (was the core widget's
    // AssistantService-backed status).
    await expect(panel.locator('.head .status')).toHaveText('notiz.md');
    // LLM features are off in the e2e profile: the panel says so quietly.
    await expect(panel.locator('.assistant-thread .empty')).toHaveText(
      'LLM features are off — nothing is summarised or answered.',
    );
    await expect(panel.locator('.assistant-panel .switch')).toBeVisible();
  });

  test('the Assistant and Actions settings pages are plugin-contributed and save immediately', async ({
    page,
  }) => {
    await openNote(page);
    await page.locator('app-status-bar .settings').click();

    const assistantCategory = page.locator('.category', { hasText: 'Assistant' });
    await assistantCategory.click();
    const assistantPage = page.locator('.assistant-settings');
    await expect(assistantPage.locator('.switch-label')).toHaveText(
      'Summarise notes automatically by default',
    );
    const switchBox = assistantPage.locator('input[type="checkbox"]');
    await expect(switchBox).toBeChecked(); // the app default

    // Rule 3: the patch lands without pressing the base Save button.
    await switchBox.click();
    await expect(switchBox).not.toBeChecked();

    // A fresh mount (navigating away and back) reads the live config: the
    // change persisted.
    await page.locator('.category', { hasText: 'Appearance' }).click();
    await assistantCategory.click();
    await expect(assistantPage.locator('input[type="checkbox"]')).not.toBeChecked();

    const actionsCategory = page.locator('.category', { hasText: 'Actions' });
    await actionsCategory.click();
    const actionsPage = page.locator('.assistant-actions-settings');
    await expect(actionsPage.locator('h3', { hasText: 'Triggers' })).toBeVisible();
    // The template library lists the built-ins. (Template names live in
    // input values, which text matchers can't see — assert on the picker's
    // option text and the built-in badges instead.)
    await expect(
      actionsPage.locator('.add-trigger option', { hasText: 'Summarise note' }),
    ).toBeAttached();
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
