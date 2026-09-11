#!/usr/bin/env node
/**
 * Hardening check for a PACKED build (ADR-0044 stage 10). Run after
 * `npm run pack:dir`:
 *
 *   node scripts/verify-pack.mjs [--exe release/win-unpacked/drey.exe]
 *
 * Verifies, against the real packaged app:
 *  1. app.asar carries every built-in plugin tree (manifest + main +
 *     renderer entry + at least the browser plugin's stylesheet);
 *  2. the packed exe boots from a throwaway profile with every built-in
 *     enabled: all plugins report `active`, `builtin: true` and a
 *     `plugin://` renderer url;
 *  3. plugin:// serves renderer modules out of the asar -- proven by the
 *     sample plugin's renderer having executed (its File-menu row exists);
 *  4. a `plugin:invoke` roundtrip reaches a plugin main inside the asar
 *     (the sample plugin's `ping`, the tasks plugin's `list`);
 *  5. startup timings: window DOM ready + the plugin DOM marker.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

import { _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');

const argExe = process.argv.indexOf('--exe');
const exePath = path.resolve(
  argExe > -1 ? process.argv[argExe + 1] : path.join(repoRoot, 'release', 'win-unpacked', 'drey.exe'),
);

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures += 1;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

if (!fs.existsSync(exePath)) {
  console.error(`packed exe not found: ${exePath}`);
  console.error('run `npm run pack:dir` first');
  process.exit(1);
}

// -- 1. asar contents -------------------------------------------------------

const asarLib = require('@electron/asar');
const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
const BUILTIN_IDS = ['assistant', 'browser', 'meeting', 'sample', 'tags', 'tasks', 'templates'];

if (fs.existsSync(asarPath)) {
  const listed = /** @type {string[]} */ (asarLib.listPackage(asarPath)).map((p) =>
    p.replaceAll('\\', '/').replace(/^\//, ''),
  );
  for (const id of BUILTIN_IDS) {
    const manifestRel = `dist-electron/plugins/${id}/plugin.json`;
    const hasManifest = listed.includes(manifestRel);
    check(`asar: plugin ${id} manifest`, hasManifest);
    // `main` is optional -- the templates plugin is renderer-only.
    // (extractFile wants native separators, listPackage emits `/`-separated.)
    const manifest = hasManifest
      ? JSON.parse(
          asarLib.extractFile(asarPath, manifestRel.split('/').join(path.sep)).toString('utf8'),
        )
      : {};
    if (manifest.main) {
      check(
        `asar: plugin ${id} main entry`,
        listed.includes(`dist-electron/plugins/${id}/${manifest.main}`),
        manifest.main,
      );
    }
    if (manifest.renderer) {
      check(
        `asar: plugin ${id} renderer entry`,
        listed.includes(`dist-electron/plugins/${id}/${manifest.renderer}`),
        manifest.renderer,
      );
    }
  }
  check('asar: browser renderer css', listed.includes('dist-electron/plugins/browser/renderer/browser.css'));
} else {
  check(`asar present at ${asarPath}`, false);
}

// -- 2-5. boot the packed exe ----------------------------------------------

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-pack-'));
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-pack-vault-'));
fs.writeFileSync(path.join(vaultDir, 'note.md'), '# note\n\nhello from the pack check\n');
fs.writeFileSync(
  path.join(userDataDir, 'vault-config.json'),
  JSON.stringify({ activeVaultPath: vaultDir }, null, 2),
);
// Every built-in enabled (the sample plugin included) -- the startup-time
// question is "with all built-ins".
fs.writeFileSync(
  path.join(userDataDir, 'app-config.json'),
  JSON.stringify({ plugins: { disabled: [] } }, null, 2),
);

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE']; // would boot Electron as plain Node (see e2e fixture)

const t0 = Date.now();
let app;
try {
  app = await electron.launch({ executablePath: exePath, args: [`--user-data-dir=${userDataDir}`], env });
} catch (error) {
  check('packed exe launches', false, String(error));
  reportAndExit();
}
check('packed exe launches', true);

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
const tDom = Date.now() - t0;

try {
  // -- 2. discovery + gating inside the asar
  const plugins = /** @type {Array<{id: string; status: string; builtin: boolean; rendererUrl?: string}>} */ (
    await page.evaluate(() => window.dreyApi.listPlugins())
  );
  for (const id of BUILTIN_IDS) {
    const p = plugins.find((entry) => entry.id === id);
    check(
      `boot: ${id} active + builtin + plugin:// url`,
      p !== undefined && p.status === 'active' && p.builtin === true && (p.rendererUrl ?? '').startsWith('plugin://'),
      p === undefined ? 'missing' : `status=${p.status} builtin=${String(p.builtin)}`,
    );
  }

  // -- 3. the renderer modules executed over plugin:// (the sample
  //       plugin registered its File-menu row)
  await page
    .locator('app-menu-bar .menu', { hasText: 'File' })
    .first()
    .locator('.menu-label')
    .click();
  const row = page.locator('app-menu-bar .popover .row', { hasText: 'Sample: open clock tab' });
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  const tMarker = Date.now() - t0;
  check('plugin:// renderer executed (sample File row visible)', true);
  await page.keyboard.press('Escape');

  // -- 4. plugin:invoke roundtrips into asar-loaded mains
  await checkInvoke('sample', 'ping', null);
  await checkInvoke('tasks', 'list', null);

  console.log(`timing: window DOM ready ${tDom} ms; plugins fully up (menu marker) ${tMarker} ms`);
} catch (error) {
  check('boot checks completed', false, String(error));
}

await reportAndExit();

async function checkInvoke(pluginId, method, payload) {
  try {
    await page.evaluate(([pid, m, p]) => window.dreyApi.invokePlugin(pid, m, p), [pluginId, method, payload]);
    check(`plugin:invoke ${pluginId}.${method} resolves`, true);
  } catch (error) {
    check(`plugin:invoke ${pluginId}.${method} resolves`, false, String(error).split('\n')[0]);
  }
}

async function reportAndExit() {
  await app?.close().catch(() => undefined);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPACK VERIFY: all checks passed' : `\nPACK VERIFY: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
