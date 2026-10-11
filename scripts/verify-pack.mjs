#!/usr/bin/env node
/**
 * Hardening check for a PACKED build (ADR-0044 stage 10). Run after
 * `npm run pack:dir`:
 *
 *   node scripts/verify-pack.mjs [--exe release/win-unpacked/drey.exe]
 *
 * Verifies, against the real packaged app:
 *  1. app.asar carries every shipped built-in plugin tree (manifest + main +
 *     renderer entry + at least the browser plugin's stylesheet) and does
 *     NOT carry the sample plugin (dev/e2e-only, excluded from packaging);
 *  2. the packed exe boots from a throwaway profile with every built-in
 *     enabled: all plugins report `active`, `builtin: true` and a
 *     `plugin://` renderer url;
 *  3. plugin:// serves renderer modules out of the asar -- proven by the
 *     assistant plugin's renderer having executed (its panel is mounted);
 *  4. a `plugin:invoke` roundtrip reaches a plugin main inside the asar
 *     (the tags plugin's `palette`, the tasks plugin's `list`);
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
const BUILTIN_IDS = ['assistant', 'browser', 'drawio', 'meeting', 'tags', 'tasks', 'templates'];
// Built but never shipped: the executable authoring reference stays out of
// the package (electron-builder.yml files negation).
const NOT_SHIPPED_IDS = ['sample'];

if (fs.existsSync(asarPath)) {
  const listed = /** @type {string[]} */ (asarLib.listPackage(asarPath)).map((p) =>
    p.replaceAll('\\', '/').replace(/^\//, ''),
  );
  // The diagrams plugin's draw.io web app (ADR-0064): every file type, not
  // only the .js / .json / .css the general globs carry.
  check(
    'asar: draw.io web app (html + stencil xml + licence)',
    listed.includes('dist-electron/plugins/drawio/webapp/index.html') &&
      listed.some((p) => p.startsWith('dist-electron/plugins/drawio/webapp/') && p.endsWith('.xml')) &&
      listed.includes('dist-electron/plugins/drawio/webapp/LICENSE'),
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
  for (const id of NOT_SHIPPED_IDS) {
    check(
      `asar: plugin ${id} excluded`,
      !listed.some((p) => p.startsWith(`dist-electron/plugins/${id}/`)),
    );
  }
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
// Every built-in enabled -- the startup-time question is "with all built-ins".
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

// The MAIN window, by URL: the splash (milestone 62) is created first, so
// `firstWindow()` can hand back a page that has no `dreyApi`. A scan loop,
// not a single `window` event -- the event fires at creation, before the
// URL has settled on its target.
const page = await findMainWindow(60_000);
if (page === null) {
  check('main window (app://) appears', false);
  await reportAndExit();
}
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

  // The draw.io web app is served out of the asar with an HTML type.
  const editorPage = await page.evaluate(async () => {
    const response = await fetch('plugin://drawio/webapp/index.html');
    return { ok: response.ok, type: response.headers.get('content-type') ?? '' };
  });
  check(
    'boot: plugin://drawio/webapp/index.html served as HTML',
    editorPage.ok && editorPage.type.startsWith('text/html'),
    JSON.stringify(editorPage),
  );

  // -- 3. the renderer modules executed over plugin:// (the assistant
  //       plugin's panel body is mounted in the right dock, expanded by
  //       default)
  const marker = page.locator('.assistant-panel').first();
  await marker.waitFor({ state: 'visible', timeout: 10_000 });
  const tMarker = Date.now() - t0;
  check('plugin:// renderer executed (assistant panel mounted)', true);

  // -- 4. plugin:invoke roundtrips into asar-loaded mains
  await checkInvoke('tags', 'palette', null);
  await checkInvoke('tasks', 'list', null);

  console.log(`timing: window DOM ready ${tDom} ms; plugins fully up (menu marker) ${tMarker} ms`);
} catch (error) {
  check('boot checks completed', false, String(error));
}

await reportAndExit();

async function findMainWindow(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = app.windows().find((candidate) => candidate.url().startsWith('app://'));
    if (hit !== undefined) {
      return hit;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined);
  }
}

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
