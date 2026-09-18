import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * The configurable daily-note storage folder (Settings -> Daily notes,
 * `AppConfig.daily.dir`): with `Journal` configured, the calendar opens a
 * day as a draft under `Journal/<y>/<m>/`, the first save writes it there,
 * and nothing is ever created under the default `daily/` root.
 */

test.describe('configured daily folder', () => {
  test.use({ appConfig: { daily: { dir: 'Journal', openOnStartup: false } } });

  test('a calendar day opens a draft in Journal/<y>/<m>/ and the save writes it there', async ({
    page,
    vaultDir,
  }) => {
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    // A non-today day of the shown month (the calendar opens on today), so
    // the click targets a cell that is not pre-selected.
    const day = now.getDate() > 1 ? now.getDate() - 1 : now.getDate() + 1;
    const dateStr = `${y}-${m}-${String(day).padStart(2, '0')}`;
    const rel = `Journal/${y}/${m}/${dateStr}.md`;

    // Day cells are `button.day` > `span.num`; `:not(.out)` keeps adjacent-
    // month cells (whose numbers repeat) out of the match.
    await page
      .locator('app-calendar button.day:not(.out) .num', { hasText: new RegExp(`^${day}$`) })
      .click();

    const tab = page.locator('app-tab-bar .tab');
    await expect(tab).toHaveAttribute('title', rel);
    // A draft: the tab exists, nothing is on disk yet.
    expect(fs.existsSync(path.join(vaultDir, rel))).toBe(false);

    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('Erster Eintrag');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('app-tab-bar .tab .dirty')).toHaveCount(0);
    await expect
      .poll(() => {
        try {
          return fs.readFileSync(path.join(vaultDir, rel), 'utf-8');
        } catch {
          return '';
        }
      })
      .toContain('Erster Eintrag');
    // And nothing leaked into the old default root.
    expect(fs.existsSync(path.join(vaultDir, 'daily'))).toBe(false);
  });
});
