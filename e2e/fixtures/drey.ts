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
   * The throwaway `--user-data-dir` of the launched app. Exposed so specs
   * can assert on app-data state (e.g. a plugin package installed under
   * `<userData>/plugins`, ADR-0068); cleaned up with the app.
   */
  userDataDir: string;
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
  /**
   * A folder OUTSIDE the seeded vault (ADR-0054): where `launchFiles` with
   * `dir: 'external'` are written, so a test can tell an out-of-vault open
   * from a vault one.
   */
  externalDir: string;
  /**
   * Files handed to the app on the command line at launch -- what an Explorer
   * double-click on a cold start does (ADR-0054). Written to disk before
   * launch; `dir` picks the seeded vault or `externalDir`.
   */
  launchFiles: Array<{ dir: 'vault' | 'external'; name: string; content: string }>;
  /**
   * Content-Security-Policy violations the main window reported during the
   * test (console text). The `page` fixture fails a test that leaves any
   * behind; a test that provokes one on purpose empties the array.
   */
  cspViolations: string[];
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

  userDataDir: async ({}, use, testInfo) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  seedVault: [{}, { option: true }],

  extraPluginDir: [null, { option: true }],

  userDataPlugins: [null, { option: true }],

  launchFiles: [[], { option: true }],

  externalDir: async ({}, use, testInfo) => {
    const dir = path.join(testInfo.outputDir, 'external');
    fs.mkdirSync(dir, { recursive: true });
    await use(dir);
  },

  electronApp: async (
    { vaultDir, appConfig, seedVault, extraPluginDir, userDataPlugins, externalDir, launchFiles, userDataDir },
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
    // The seeded vault sits under `test-results/` INSIDE this repo's
    // checkout (so a failure uploads it), which makes git's upward
    // discovery find the repo itself: every test vault would pose as a Git
    // vault of the Drey sources -- in CI a full clone with real branches,
    // one confirmed dialog away from merging inside the checkout (bug-12).
    // A ceiling at the repo root stops discovery before it leaves the test
    // tree; the git specs init their repositories inside the vault, which
    // the ceiling does not touch.
    env['GIT_CEILING_DIRECTORIES'] = env['GIT_CEILING_DIRECTORIES']
      ? `${env['GIT_CEILING_DIRECTORIES']}${path.delimiter}${repoRoot}`
      : repoRoot;
    if (extraPluginDir !== null) {
      env['DREY_EXTRA_PLUGIN_DIR'] = extraPluginDir;
    }

    const launchPaths = launchFiles.map((file) => {
      const target = path.join(file.dir === 'vault' ? vaultDir : externalDir, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
      return target;
    });

    const app = await electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`, ...launchPaths],
      env,
    });

    await use(app);

    // The save-before-exit prompt (bug-5): a test that leaves a dirty
    // document makes main's intercepted close show the exit dialog, which
    // would hang `app.close()` forever with nobody to answer it. Race the
    // close against a click on "Exit without saving" -- the session backups
    // (ADR-0043) already keep those buffers restorable, which is exactly
    // what that button promises. For a clean exit the click finds nothing
    // and times out into the void.
    const closing = app.close().catch(() => undefined);
    // The MAIN window's page (milestone 62: the splash window also exists
    // at teardown time in principle, and first/windows()[0] must not grab
    // it).
    const win = app.windows().find((w) => w.url().startsWith('app://'));
    await win
      ?.locator('app-exit-confirm-dialog .dialog button', { hasText: 'Exit without saving' })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await closing;
    // `userDataDir` (own fixture) does the cleanup.
  },

  cspViolations: async ({}, use) => {
    await use([]);
  },

  page: async ({ electronApp, cspViolations }, use) => {
    // Milestone 62: the splash window is created FIRST, so the main
    // window is no longer `firstWindow()` — pick the one that loads the
    // app itself (production `app://`; e2e always forces that URL).
    const isMainWindow = (candidate: Page): boolean => candidate.url().startsWith('app://');
    const deadline = Date.now() + 120_000;
    let page = electronApp.windows().find(isMainWindow) ?? null;
    while (page === null && Date.now() < deadline) {
      await electronApp
        .waitForEvent('window', { predicate: isMainWindow, timeout: 2_000 })
        .catch(() => undefined);
      page = electronApp.windows().find(isMainWindow) ?? null;
    }
    if (page === null) {
      throw new Error('the main app:// window never appeared');
    }
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) {
        cspViolations.push(message.text());
      }
    });
    await page.waitForLoadState('domcontentloaded');
    // The hidden-until-ready handover (ADR-0062): wait for the window to
    // be shown and focused (or fall through on timeout — the fail-opens
    // guarantee it eventually). Hidden windows render
    // (paintWhenInitiallyHidden), so these are purely the shown-gates;
    // input dispatched in the gap between the visibility flip and the OS
    // window being mapped gets dropped, which the focus wait + settle
    // absorbs.
    await page
      .waitForFunction(
        () => document.visibilityState === 'visible' && document.hasFocus(),
        undefined,
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(150);
    await use(page);
    // The policy must not get in the way of anything the app does itself.
    expect(cspViolations).toEqual([]);
  },
});

export const expect = test.expect;
