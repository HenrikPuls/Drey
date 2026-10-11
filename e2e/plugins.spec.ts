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
 *
 * The "plugin system" and "plugin doc kinds" suites also assert against
 * the bundled `sample` plugin (status reporting + its clock tab). Since
 * ADR-0068 a plain `npm run build` does NOT produce it — fail fast with
 * the remedy instead of cryptic missing-plugin errors.
 */
const repoRoot = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(repoRoot, 'dist-electron', 'plugins', 'sample', 'plugin.json'))) {
  throw new Error(
    'dist-electron/plugins/sample is missing — run `npm run e2e` (a plain `npm run build` excludes the sample plugin; the e2e script builds it via DREY_BUILD_SAMPLE_PLUGINS=1).',
  );
}

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
 * A plugin installed the way a user would -- dropped into
 * `<userData>/plugins/<id>/` (the app-level discovery root, not a dev
 * override) -- is discovered, activates, reports `builtin: false`, and
 * shows up with its status in Settings -> Panels & plugins. Also the
 * only suite coverage of that settings page.
 */
test.describe('user-installed plugin', () => {
  const USER_MANIFEST = {
    ...MANIFEST,
    id: 'e2e-user',
    name: 'E2E user plugin',
    description: 'Installed into <userData>/plugins',
  };

  test.use({
    userDataPlugins: {
      'e2e-user': {
        'plugin.json': JSON.stringify(USER_MANIFEST, null, 2),
        'main/index.js':
          'module.exports = { activate(ctx) { ctx.ipc.handle("ping", () => ({ ok: true })); } };',
        'renderer/index.js': `
const mod = {
  activate(api) {
    void api; // discovery + listing is what the spec asserts
  },
};
export default mod;
`,
      },
    },
  });

  test('is discovered from <userData>/plugins and listed in Settings', async ({ page }) => {
    const plugins = await page.evaluate(() => window.dreyApi.listPlugins());
    const installed = plugins.find((p) => p.id === 'e2e-user');
    expect(installed).toMatchObject({ status: 'active', builtin: false });
    expect(installed?.rendererUrl).toBe('plugin://e2e-user/renderer/index.js');

    // The Panels & plugins settings page lists it with its status.
    await page.locator('app-status-bar .settings').click();
    await page.locator('.category', { hasText: 'Panels & plugins' }).click();
    const row = page.locator('.switch-row', { hasText: 'E2E user plugin' });
    await expect(row).toBeVisible();
    await expect(row.locator('.plugin-status')).toHaveText('active');
    await expect(row).toContainText('installed');
    // ADR-0068: user-installed rows carry a Remove action; built-ins don't.
    await expect(page.locator('[data-plugin-remove="e2e-user"]')).toBeVisible();
    await expect(page.locator('[data-plugin-remove="tags"]')).toHaveCount(0);
    // The package install entry point exists on the same page.
    await expect(page.locator('[data-plugin-install]')).toBeVisible();
  });
});

/**
 * Local plugin packages (ADR-0068): `installPluginPackage` / `uninstallPlugin`
 * behind Settings -> Panels & plugins. The zip is written here by a small
 * store-only writer (no dependencies) -- the spec doubles as the executable
 * definition of the package format: `plugin.json` at the archive root, the
 * built plugin folder's contents as the archive's contents.
 */
test.describe('plugin packages', () => {
  const PKG_MANIFEST = {
    ...MANIFEST,
    id: 'e2e-pkg',
    name: 'E2E package plugin',
    description: 'Installed from a .zip via installPluginPackage',
  };

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(data: Buffer): number {
    let c = ~0;
    for (const byte of data) {
      c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    }
    return ~c >>> 0;
  }

  /** Minimal store-only zip (local headers + central directory + EOCD). */
  function writeZip(files: Record<string, string | Buffer>): string {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    const count = Object.keys(files).length;
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      parts.push(local, nameBuf, data);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // version made by
      entry.writeUInt16LE(20, 6); // version needed
      entry.writeUInt16LE(0, 8); // flags
      entry.writeUInt16LE(0, 10); // method: stored
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(nameBuf.length, 28);
      entry.writeUInt32LE(offset, 42);
      central.push(entry, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const zipPath = test.info().outputPath('plugin-package.zip');
    fs.writeFileSync(zipPath, Buffer.concat([...parts, cd, eocd]));
    return zipPath;
  }

  function packageFiles(overrides: Record<string, string | Buffer> = {}): Record<string, string | Buffer> {
    return {
      'plugin.json': JSON.stringify(PKG_MANIFEST, null, 2),
      'main/index.js':
        'module.exports = { activate(ctx) { ctx.ipc.handle("ping", () => ({ ok: true })); } };',
      'renderer/index.js': 'const mod = { activate(api) { void api; } }; export default mod;',
      ...overrides,
    };
  }

  function install(page: Page, zipPath: string): Promise<Record<string, unknown>> {
    return page.evaluate((p) => window.dreyApi.installPluginPackage(p), zipPath);
  }

  test('installs a package under <userData>/plugins; it applies on the next start', async ({
    page,
    userDataDir,
  }) => {
    const zipPath = writeZip(packageFiles());
    const result = await install(page, zipPath);
    expect(result).toMatchObject({ status: 'installed', pluginId: 'e2e-pkg', upgraded: false });

    // Extracted to the app-level discovery root, manifest at the folder root,
    // no staging leftovers (other folders = plugin config dirs, not packages).
    expect(fs.existsSync(path.join(userDataDir, 'plugins', 'e2e-pkg', 'plugin.json'))).toBe(true);
    const rootEntries = fs.readdirSync(path.join(userDataDir, 'plugins'));
    expect(rootEntries.includes('e2e-pkg')).toBe(true);
    expect(rootEntries.includes('.staging-e2e-pkg')).toBe(false);

    // Applies on restart: the discovery snapshot of this run is unchanged.
    const plugins = await page.evaluate(() => window.dreyApi.listPlugins());
    expect(plugins.find((p) => p.id === 'e2e-pkg')).toBeUndefined();
  });

  test('strips Node module-type markers the way older tutorial revisions packed them', async ({
    page,
    userDataDir,
  }) => {
    const zipPath = writeZip(
      packageFiles({
        'package.json': '{"type":"module"}',
        'main/package.json': '{"type":"commonjs"}',
      }),
    );
    const result = await install(page, zipPath);
    expect(result).toMatchObject({ status: 'installed', pluginId: 'e2e-pkg' });

    // A surviving root marker would make Node parse the CommonJS main/shared
    // output as ESM ("exports is not defined in ES module scope").
    const target = path.join(userDataDir, 'plugins', 'e2e-pkg');
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'main', 'package.json'))).toBe(false);
  });

  test('an upgrade replaces the files but keeps config.json', async ({ page, userDataDir }) => {
    const existing = path.join(userDataDir, 'plugins', 'e2e-pkg');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'plugin.json'), 'not a real manifest');
    fs.writeFileSync(path.join(existing, 'config.json'), '{"greeting":"keep me"}');

    const result = await install(page, writeZip(packageFiles()));
    expect(result).toMatchObject({ status: 'installed', pluginId: 'e2e-pkg', upgraded: true });
    expect(fs.readFileSync(path.join(existing, 'config.json'), 'utf8')).toBe('{"greeting":"keep me"}');
  });

  test('refuses broken packages with a typed error and writes nothing', async ({
    page,
    userDataDir,
  }) => {
    const missingMain = packageFiles();
    delete missingMain['main/index.js'];
    const cases: Array<[Record<string, string | Buffer>, string]> = [
      [{ 'nested/plugin.json': JSON.stringify(PKG_MANIFEST) }, 'no-manifest'],
      [
        { 'plugin.json': '{"id": "Bad Id", "name": "x", "version": "1", "apiVersion": 1}' },
        'invalid-manifest',
      ],
      [packageFiles({ 'plugin.json': JSON.stringify({ ...PKG_MANIFEST, apiVersion: 99 }) }), 'api-version'],
      [
        packageFiles({ 'plugin.json': JSON.stringify({ ...PKG_MANIFEST, id: 'tags', name: 'Fake tags' }) }),
        'builtin-collision',
      ],
      [packageFiles({ '../evil.txt': 'escaped' }), 'unsafe-entry'],
      [missingMain, 'missing-entry'],
    ];
    for (const [files, reason] of cases) {
      const zipPath = writeZip(files);
      const result = await install(page, zipPath);
      expect(result, reason).toMatchObject({ status: 'error', reason });
    }
    // Not a zip at all.
    const notZip = test.info().outputPath('not-a-zip.zip');
    fs.writeFileSync(notZip, 'definitely not a zip archive');
    expect(await install(page, notZip)).toMatchObject({ status: 'error', reason: 'not-a-zip' });

    // Nothing was written to the discovery root through all of that.
    expect(fs.existsSync(path.join(userDataDir, 'plugins', 'e2e-pkg'))).toBe(false);
    const pluginsRoot = path.join(userDataDir, 'plugins');
    const rootEntries = fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : [];
    expect(rootEntries.includes('.staging-e2e-pkg')).toBe(false);
  });

  test.describe('removal', () => {
    test.use({
      userDataPlugins: {
        'e2e-user': {
          'plugin.json': JSON.stringify({ ...MANIFEST, id: 'e2e-user', name: 'E2E user plugin' }),
          'main/index.js':
            'module.exports = { activate(ctx) { ctx.ipc.handle("ping", () => ({ ok: true })); } };',
          'renderer/index.js': 'const mod = { activate(api) { void api; } }; export default mod;',
        },
      },
    });

    test('removes a user-installed plugin but refuses built-in ids', async ({ page, userDataDir }) => {
      const builtin = await page.evaluate(() => window.dreyApi.uninstallPlugin('tags'));
      expect(builtin).toMatchObject({ status: 'error', reason: 'builtin' });

      const removed = await page.evaluate(() => window.dreyApi.uninstallPlugin('e2e-user'));
      expect(removed).toMatchObject({ status: 'removed', pluginId: 'e2e-user' });
      expect(fs.existsSync(path.join(userDataDir, 'plugins', 'e2e-user'))).toBe(false);

      // This run keeps its discovery snapshot -- the removal applies on restart.
      const plugins = await page.evaluate(() => window.dreyApi.listPlugins());
      expect(plugins.find((p) => p.id === 'e2e-user')?.status).toBe('active');
    });
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
