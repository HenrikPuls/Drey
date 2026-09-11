import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * The runtime plugin system end to end (ADR-0044): discovery from the
 * extra root AND the bundled root, main + renderer activation, the fixed
 * IPC channels, and a plugin widget mounting real DOM into the dock.
 *
 * The plugin under test is written here as plain JS (ESM renderer, CJS
 * main) — no build step, so the spec is self-contained and doubles as an
 * executable example of the manifest + module shapes.
 */

const MANIFEST = {
  id: 'e2e',
  name: 'E2E plugin',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Written by plugins.spec.ts',
  main: 'main/index.js',
  renderer: 'renderer/index.js',
  permissions: ['documents', 'commands', 'settings', 'main-process'],
};

const RENDERER_JS = `
const mod = {
  activate(api) {
    api.ui.registerWidget({
      id: 'e2e',
      title: 'E2E',
      defaultDock: 'left',
      defaultOpen: true,
      defaultFlex: 120,
      status: () => 'e2e ok',
      mount(body) {
        const line = document.createElement('div');
        line.textContent = 'e2e plugin widget';
        line.setAttribute('data-e2e-plugin', 'mounted');
        body.appendChild(line);
        return () => undefined;
      },
    });
    api.ui.registerSettingsPage({
      id: 'e2e',
      label: 'E2E plugin',
      hint: 'from plugins.spec',
      mount(body) {
        const p = document.createElement('p');
        p.textContent = 'e2e plugin settings page';
        p.setAttribute('data-e2e-plugin', 'settings');
        body.appendChild(p);
        return () => undefined;
      },
    });
  },
};
export default mod;
`;

test.describe('plugin system', () => {
  test.use({
    // `appConfig` keeps the fixture default, which disables the bundled
    // `sample` plugin — the tests below assert it reports `disabled`.
    extraPluginDir: async ({}, use, testInfo) => {
      const dir = path.join(testInfo.outputDir, 'extra-plugins', 'e2e');
      fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(MANIFEST, null, 2));
      // `module.exports = {...}` (CJS) — the shape tsc emits for a TS main entry.
      fs.writeFileSync(
        path.join(dir, 'main', 'index.js'),
        'module.exports = { activate(ctx) { ctx.ipc.handle("ping", (p) => ({ ok: true, echoed: p, appVersion: ctx.app.appVersion })); } };',
      );
      fs.writeFileSync(path.join(dir, 'renderer', 'index.js'), RENDERER_JS);
      await use(path.join(testInfo.outputDir, 'extra-plugins'));
    },
  });

  test('loads a plugin from the extra dir and mounts its widget', async ({ page }) => {
    const panel = page.locator('app-panel-frame', { has: page.locator('text=E2E') }).first();
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-e2e-plugin="mounted"]')).toHaveText('e2e plugin widget');
    // The header status value comes from the plugin's status() callback.
    await expect(panel.locator('.status')).toHaveText('e2e ok');
  });

  test('routes plugin:invoke to the plugin main entry and back', async ({ page }) => {
    const reply = await page.evaluate(() =>
      window.dreyApi.invokePlugin('e2e', 'ping', { hello: 'drey' }),
    );
    expect(reply).toMatchObject({ ok: true, echoed: { hello: 'drey' } });
  });

  test('rejects an unregistered method and an unknown plugin', async ({ page }) => {
    await expect(
      page.evaluate(() => window.dreyApi.invokePlugin('e2e', 'no-such-method', null)),
    ).rejects.toThrow(/does not handle/);
    await expect(
      page.evaluate(() => window.dreyApi.invokePlugin('missing', 'ping', null)),
    ).rejects.toThrow(/no active main entry/);
  });

  test('lists the plugin with its status (extra dir + bundled sample disabled)', async ({
    page,
  }) => {
    const plugins = await page.evaluate(() => window.dreyApi.listPlugins());
    const e2e = plugins.find((p) => p.id === 'e2e');
    expect(e2e).toMatchObject({ status: 'active', builtin: false });
    expect(e2e?.rendererUrl).toBe('plugin://e2e/renderer/index.js');
    // Seeded disabled by the fixture default — never imported, still reported.
    const sample = plugins.find((p) => p.id === 'sample');
    expect(sample).toBeDefined();
    expect(sample!.status).toBe('disabled');
  });

  test('plugin settings page appears and mounts', async ({ page }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('.category', { hasText: 'E2E plugin' }).click();
    await expect(page.locator('[data-e2e-plugin="settings"]')).toHaveText(
      'e2e plugin settings page',
    );
  });
});

/**
 * The doc-kind seam (ADR-0044 stage 8A), exercised through the bundled
 * sample plugin's clock tab: the pane body, the tab-strip glyph and the
 * status-bar slot resolve through `DocKindRegistry`, and a plugin tab
 * survives a restart through the session.
 */
test.describe('plugin doc kinds', () => {
  // Re-enable the bundled sample plugin (the fixture default disables it).
  test.use({ appConfig: { plugins: { disabled: [] } } });

  async function openClockTab(page: Page): Promise<void> {
    await page
      .locator('app-menu-bar .menu', { hasText: 'File' })
      .first()
      .locator('.menu-label')
      .click();
    await page.locator('app-menu-bar .popover .row', { hasText: 'Sample: open clock tab' }).click();
  }

  test('a plugin doc kind opens as a tab and drives the pane, tab strip and status bar', async ({
    page,
  }) => {
    await openClockTab(page);

    const tab = page.locator('app-tab-bar .tab', { hasText: 'Sample clock' });
    await expect(tab).toBeVisible();
    // No favicon slot -> the kind's fallback glyph (not an img).
    await expect(tab.locator('img.favicon')).toHaveCount(0);
    await expect(tab.locator('app-icon.favicon')).toBeVisible();

    // The pane body is the plugin's mounted DOM (the PluginDocHost div).
    await expect(
      page.locator('app-pane-leaf').getByText('contributed by the sample plugin'),
    ).toBeVisible();
    // The status bar slot reads the kind's statusText.
    await expect(page.locator('app-status-bar .count.url')).toHaveText('sample clock');
  });

  test('a plugin doc-kind tab survives a reload through the session', async ({ page }) => {
    await openClockTab(page);
    await expect(
      page.locator('app-pane-leaf').getByText('contributed by the sample plugin'),
    ).toBeVisible();
    // The session layout save is debounced -- wait it out before reloading.
    await page.waitForTimeout(700);
    await page.reload();

    // Plugins load first (bootstrap gating), then the session restores the
    // plugin tab through the registry.
    await expect(
      page.locator('app-pane-leaf').getByText('contributed by the sample plugin'),
    ).toBeVisible();
    await expect(page.locator('app-tab-bar .tab', { hasText: 'Sample clock' })).toBeVisible();
  });
});

/**
 * The browser plugin (ADR-0044 stage 8B): the in-editor browser tab is no
 * longer a base feature -- it registers the `browser` doc kind, the
 * `browser.new` command and its File-menu row from the plugin. The native
 * `WebContentsView` itself is not asserted here (it floats above the DOM
 * and stays invisible in CI); what the spec proves is the seam: tab
 * creation through the plugin's command, the registry-driven chrome
 * (glyph, status line, pane body) and the session restore.
 */
test.describe('browser plugin', () => {
  async function openBrowserTab(page: Page): Promise<void> {
    await page
      .locator('app-menu-bar .menu', { hasText: 'File' })
      .first()
      .locator('.menu-label')
      .click();
    await page.locator('app-menu-bar .popover .row', { hasText: 'New browser tab' }).click();
  }

  test('opens a browser tab through the plugin command and drives the seam', async ({ page }) => {
    await openBrowserTab(page);

    const tab = page.locator('app-tab-bar .tab', { hasText: 'New tab' });
    await expect(tab).toBeVisible();
    // No favicon yet -> the kind's fallback globe glyph (not an img).
    await expect(tab.locator('img.favicon')).toHaveCount(0);
    await expect(tab.locator('app-icon.favicon')).toBeVisible();

    // The pane body is the plugin's mounted chrome (toolbar + viewport).
    await expect(page.locator('.drey-browser-toolbar')).toBeVisible();
    await expect(page.locator('.drey-browser-viewport')).toBeVisible();
    // The status bar slot reads the kind's statusText (about:blank -> "New tab").
    await expect(page.locator('app-status-bar .count.url')).toHaveText('New tab');
  });

  test('a browser tab survives a reload through the session', async ({ page }) => {
    await openBrowserTab(page);
    await expect(page.locator('.drey-browser-toolbar')).toBeVisible();
    // The session layout save is debounced -- wait it out before reloading.
    await page.waitForTimeout(700);
    await page.reload();

    // Plugins load first (bootstrap gating), then the session restores the
    // browser tab through the registry and the plugin recreates the tab.
    await expect(page.locator('app-tab-bar .tab', { hasText: 'New tab' })).toBeVisible();
    await expect(page.locator('.drey-browser-toolbar')).toBeVisible();
  });
});
