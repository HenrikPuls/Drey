import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/** A 1x1 transparent PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

test.describe('image capture — vault:save-asset IPC (ADR-0024)', () => {
  test('saves bytes into an attachments/ folder beside the note and returns a note-relative path', async ({
    page,
    vaultDir,
  }) => {
    const rel = await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return window.dreyApi.saveVaultAsset(bytes, 'png', 'notes/topic/foo.md');
    }, PNG_BASE64);

    expect(rel).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{6}\.png$/);

    const onDisk = path.join(vaultDir, 'notes', 'topic', rel);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).length).toBe(Buffer.from(PNG_BASE64, 'base64').length);
  });

  test('falls back to the vault-root attachments/ when there is no open note', async ({
    page,
    vaultDir,
  }) => {
    const rel = await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return window.dreyApi.saveVaultAsset(bytes, 'png', '');
    }, PNG_BASE64);

    expect(rel).toMatch(/^attachments\/.+\.png$/);
    expect(fs.existsSync(path.join(vaultDir, rel))).toBe(true);
  });
});
