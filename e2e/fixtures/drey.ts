import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const electronMain = path.join(repoRoot, 'dist-electron', 'electron', 'main.js');

interface DreyFixtures {
  /**
   * A throwaway vault folder on disk, pre-registered as the active vault
   * (see `vaultDir` seeding below). Write `.md` files into it before or
   * during a test and hit the app's refresh to see them.
   */
  vaultDir: string;
  /**
   * Partial `app-config.json` to seed before launch (merged into defaults by
   * the app's own `normalizeAppConfig`). Overridden per file/describe with
   * `test.use({ appConfig: { editor: { fontFamily: 'mono' } } })`; the
   * fixture merges it over `{ plugins: { disabled: ['sample'] } }` so the
   * built-in sample plugin (an extra right-dock panel) stays out of every
   * layout-sensitive test unless a test explicitly re-enables it.
   */
  appConfig: Record<string, unknown>;
  /**
   * Files written into `vaultDir` before the app launches (`relativePath ->
   * content`), so they are on disk for the startup vault scan -- plugin
   * indexes (tasks/tags) and the file tree see them from the first build,
   * with no in-app refresh needed.
   */
  seedVault: Record<string, string>;
  /**
   * A plugin directory exposed to the app via `DREY_EXTRA_PLUGIN_DIR`
   * (ADR-0044), or null. `plugins.spec.ts` writes a self-contained plugin
   * (plain JS, no build step) into it before launch.
   */
  extraPluginDir: string | null;
  /**
   * Plugins to install the way a user would: `{ pluginId: { relativePath:
   * content } }`, written under `<userDataDir>/plugins/<pluginId>/` before
   * launch — the app-level discovery root, not a dev override.
   */
  userDataPlugins: Record<string, Record<string, string>> | null;
  /** The launched Electron app. */
  electronApp: ElectronApplication;
  /** The main window's renderer page. */
  page: Page;
}

/**
 * Every test gets an isolated `--user-data-dir`, so app config
 * (`vault-config.json`, `app-config.json`) never touches the real profile
 * and never leaks between tests. We seed `vault-config.json` up front
 * because the only other way to set the active vault is the native folder
 * picker, which Playwright cannot drive.
 */
export const test = base.extend<DreyFixtures>({
  vaultDir: async ({}, use, testInfo) => {
    const dir = path.join(testInfo.outputDir, 'vault');
    fs.mkdirSync(dir, { recursive: true });
    await use(dir);
  },

  appConfig: [{}, { option: true }],

  seedVault: [{}, { option: true }],

  extraPluginDir: [null, { option: true }],

  userDataPlugins: [null, { option: true }],

  electronApp: async (
    { vaultDir, appConfig, seedVault, extraPluginDir, userDataPlugins },
    use,
    testInfo,
  ) => {
    if (!fs.existsSync(electronMain)) {
      throw new Error(
        `${electronMain} is missing -- run \`npm run build\` (or \`npm run e2e\`) before the E2E suite.`,
      );
    }

    // Pre-launch vault seeding (see the `seedVault` fixture docstring).
    for (const [relativePath, content] of Object.entries(seedVault)) {
      const target = path.join(vaultDir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-'));
    fs.writeFileSync(
      path.join(userDataDir, 'vault-config.json'),
      JSON.stringify({ activeVaultPath: vaultDir }, null, 2),
    );
    // User-installed plugins land in the app-level discovery root
    // (`<userData>/plugins/<id>/`, ADR-0044) — indistinguishable from a
    // real install from the app's point of view.
    for (const [pluginId, files] of Object.entries(userDataPlugins ?? {})) {
      for (const [relativePath, content] of Object.entries(files)) {
        const target = path.join(userDataDir, 'plugins', pluginId, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
    const seededConfig = { plugins: { disabled: ['sample'] }, ...appConfig };
    if (Object.keys(seededConfig).length > 0) {
      fs.writeFileSync(
        path.join(userDataDir, 'app-config.json'),
        JSON.stringify(seededConfig, null, 2),
      );
    }

    // Electron only checks whether ELECTRON_RUN_AS_NODE *exists*, not its
    // value, so it must be deleted, not blanked. It is commonly present
    // when the suite is launched from a terminal inside an Electron host
    // (VS Code, and this repo's own tooling -- see scripts/run-electron.js).
    // Left in place, Electron boots as plain Node and the launch fails.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    delete env['ELECTRON_RUN_AS_NODE'];
    // Force the production `app://` renderer even if the caller's shell
    // still has DREY_RENDERER_URL exported from `npm run dev`.
    env['DREY_RENDERER_URL'] = '';
    if (extraPluginDir !== null) {
      env['DREY_EXTRA_PLUGIN_DIR'] = extraPluginDir;
    }

    const app = await electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      env,
    });

    await use(app);

    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export const expect = test.expect;
