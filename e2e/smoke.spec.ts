import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

test.describe('app shell', () => {
  test('launches and renders the titlebar, dock and status bar', async ({ page }) => {
    await expect(page.locator('app-titlebar .brand .name')).toHaveText('Drey');
    await expect(page.locator('app-dock[side="left"]')).toBeVisible();
    await expect(page.locator('app-status-bar')).toContainText('words');
    await expect(page.locator('app-status-bar')).toContainText('chars');
  });

  test('the contextBridge IPC surface is wired up', async ({ page }) => {
    // No "not running inside Electron" banner -> window.dreyApi resolved.
    await expect(page.locator('.ipc-warning')).toHaveCount(0);

    const info = await page.evaluate(() => window.dreyApi.getAppInfo());
    expect(info.platform).toBe(process.platform);
    expect(info.electronVersion).toMatch(/^\d+\./);
  });

  test('boots with the seeded vault active and reads it over IPC', async ({ page, vaultDir }) => {
    const activeVault = await page.evaluate(() => window.dreyApi.getActiveVault());
    expect(activeVault).toBe(vaultDir);

    // Drop a file straight onto disk, then read the vault back through the
    // real vault:list-files handler -- exercises IPC + main-process fs.
    fs.writeFileSync(path.join(vaultDir, 'hello.md'), '# hello\n\n#demo\n');
    const files = await page.evaluate(() => window.dreyApi.listVaultFiles());
    expect(files.map((f) => f.relativePath)).toContain('hello.md');
  });
});
