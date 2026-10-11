import { _electron, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from './fixtures/drey';

/**
 * The startup splash (milestone 62, ADR-0062). This suite launches its
 * own app instance instead of using the shared `page` fixture: the
 * splash window is only catchable by watching for windows from the very
 * first moment — by the time that fixture has resolved, the handover has
 * usually already closed it. No vault is seeded, so the no-vault ready
 * path is covered too.
 */

const repoRoot = path.resolve(__dirname, '..');
const electronMain = path.join(repoRoot, 'dist-electron', 'electron', 'main.js');

test.describe('startup splash (milestone 62, ADR-0062)', () => {
  test('shows logo + progress and hands over to the workspace', async () => {
    if (!fs.existsSync(electronMain)) {
      throw new Error(`${electronMain} is missing -- run \`npm run build\` first.`);
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-splash-'));
    // The fixtures' env hygiene: delete ELECTRON_RUN_AS_NODE (existence
    // alone switches Electron to plain Node), force the production
    // `app://` renderer.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    delete env['ELECTRON_RUN_AS_NODE'];
    env['DREY_RENDERER_URL'] = '';

    const app = await _electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      env,
    });

    // The splash appears first and carries the version from its first
    // progress push (latched + replayed by the controller). The scan
    // loop (not a single `window` event): the event fires at creation,
    // before the URL has settled on its target.
    const findWindow = async (matches: (candidate: Page) => boolean, ms: number): Promise<Page> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = app.windows().find(matches) ?? null;
        if (hit !== null) {
          return hit;
        }
        if (Date.now() >= deadline) {
          throw new Error('expected window never appeared');
        }
        await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
      }
    };
    const splash = await findWindow((c) => c.url().includes('splash.html'), 30_000);
    // Listen for the close NOW: with no vault the boot is short, and the
    // handover can close the splash before the checks below are through —
    // a listener registered after them would wait for an event long gone.
    const splashClosed: Promise<unknown> = splash.isClosed()
      ? Promise.resolve()
      : splash.waitForEvent('close', { timeout: 120_000 });
    splashClosed.catch(() => undefined);

    // The content is checked only while the splash is still up: a splash
    // the handover already closed is a fast boot, not a failure (the
    // locator then dies with "session closed"). What must hold either way
    // is the handover below.
    try {
      // The logo draws the "d"; the letters after it complete the name.
      await expect(splash.locator('.wordmark')).toHaveAttribute('aria-label', 'drey');
      await expect(splash.locator('.wordmark .mark')).toBeVisible();
      await expect(splash.locator('.wordmark .rest')).toHaveText('rey');
      await expect(splash.locator('.version')).toHaveText(/\d/);
      await expect(splash.locator('.fill')).toBeVisible();
      await expect(splash.locator('.activity')).not.toBeEmpty();
    } catch (error) {
      if (!splash.isClosed()) {
        throw error;
      }
    }

    // Then the (hidden) main window boots, and the handover shows it
    // painted and closes the splash.
    const main = await findWindow((c) => c.url().startsWith('app://'), 60_000);
    await main.waitForLoadState('domcontentloaded');
    await expect(main.locator('app-titlebar .brand .mark')).toBeVisible({ timeout: 60_000 });

    await splashClosed;
    expect(splash.isClosed()).toBe(true);
    // Nothing splash-shaped lingers after the handover.
    expect(app.windows().some((candidate) => candidate.url().includes('splash.html'))).toBe(
      false,
    );

    await app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
});
