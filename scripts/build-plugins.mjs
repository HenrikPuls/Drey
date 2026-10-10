/**
 * Builds the built-in plugins (ADR-0044), no bundler involved. ONE output
 * tree per plugin — `dist-electron/plugins/<id>/` holds the manifest, the
 * CJS main entry AND the ES-module renderer — because `plugin://` resolves
 * every URL root-relative against that one directory:
 *
 *   plugins/<id>/main/index.ts   -> dist-electron/plugins/<id>/main/*.js    (CJS, Node16)
 *   plugins/<id>/renderer/*.ts   -> dist-electron/plugins/<id>/renderer/*.js (ESM, ES2022)
 *   plugins/<id>/plugin.json     -> dist-electron/plugins/<id>/plugin.json
 *   plugins/<id>/renderer/*.css  -> dist-electron/plugins/<id>/renderer/*.css
 *
 * The renderer tsc emits through a scratch tree (dist-plugins) because its
 * rootDir is the repo root (it typechecks against `shared/`); the script
 * normalizes + merges it into the plugin dirs above and removes the scratch.
 *
 * The renderer output must contain no bare-specifier runtime imports — a
 * dynamic `import()` of `plugin://…` in the renderer would fail loudly on
 * one, which is exactly the failure mode we want (ADR-0044 rule 1).
 *
 * One output tree also means one directory mixing module systems: main/ is
 * CommonJS, while shared/ is emitted as ES modules — the renderer imports
 * it at runtime over `plugin://`, and the plugin main sides `require()` the
 * same files (supported by the Node inside Electron >= 22). Node decides
 * how to parse a .js file from the nearest package.json's `type`; with none
 * present it sniffs the syntax and warns MODULE_TYPELESS_PACKAGE_JSON plus
 * reparses every file. The merge step therefore drops a
 * {"type":"module"} marker at the plugin root and {"type":"commonjs"} into
 * main/, so no file is typeless and nothing needs sniffing. The browser
 * ignores package.json entirely, so renderer/ over `plugin://` is unaffected.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const pluginsDir = path.join(repoRoot, 'plugins');
const mainOut = path.join(repoRoot, 'dist-electron');
const rendererOut = path.join(repoRoot, 'dist-plugins');

function run(config) {
  const result = spawnSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`tsc failed for ${config}`);
  }
}

run(path.join(pluginsDir, 'tsconfig.main.json'));
run(path.join(pluginsDir, 'tsconfig.renderer.json'));

// The renderer tsconfig's rootDir is the repo root, so tsc emits
// `dist-plugins/plugins/<id>/renderer`. Normalize to `dist-plugins/<id>`,
// then merge every plugin's renderer into its one true directory under
// `dist-electron/plugins/<id>/` (next to plugin.json + main/).
const emittedWrapper = path.join(rendererOut, 'plugins');
if (existsSync(emittedWrapper)) {
  for (const entry of readdirSync(emittedWrapper)) {
    const from = path.join(emittedWrapper, entry);
    const to = path.join(rendererOut, entry);
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
  }
  rmSync(emittedWrapper, { recursive: true, force: true });
}

for (const entry of readdirSync(pluginsDir)) {
  const pluginDir = path.join(pluginsDir, entry);
  if (!statSync(pluginDir).isDirectory() || !existsSync(path.join(pluginDir, 'plugin.json'))) {
    continue;
  }
  const pluginOut = path.join(mainOut, 'plugins', entry);
  mkdirSync(pluginOut, { recursive: true });
  // Module-type markers, see the header note: shared/ + renderer/ are ESM,
  // main/ is CJS. Rewritten every build (clean wipes dist-electron/).
  writeFileSync(path.join(pluginOut, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  const mainOutDir = path.join(pluginOut, 'main');
  mkdirSync(mainOutDir, { recursive: true });
  writeFileSync(path.join(mainOutDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
  // The manifest is read by discovery from the rootDir.
  cpSync(path.join(pluginDir, 'plugin.json'), path.join(pluginOut, 'plugin.json'));
  // Merge the renderer tree (modules + css + anything else static) next to
  // the manifest, so `plugin://<id>/renderer/…` resolves from one root.
  const rendererSrc = path.join(rendererOut, entry);
  if (existsSync(rendererSrc)) {
    cpSync(rendererSrc, pluginOut, { recursive: true });
  }
  // Static assets the compiler does not emit (stylesheets): copy explicitly.
  const staticSrc = path.join(pluginDir, 'renderer');
  if (existsSync(staticSrc)) {
    for (const file of readdirSync(staticSrc)) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) {
        const dest = path.join(pluginOut, 'renderer');
        mkdirSync(dest, { recursive: true });
        cpSync(path.join(staticSrc, file), path.join(dest, file));
      }
    }
  }
  // Third-party runtime files a plugin serves as they are (the diagrams
  // plugin's draw.io web app, fetched by scripts/fetch-drawio.mjs and not
  // in git): `plugins/<id>/vendor/*` lands at the plugin root, so
  // `vendor/webapp/` is `plugin://<id>/webapp/`. Absent when not fetched.
  const vendorSrc = path.join(pluginDir, 'vendor');
  if (existsSync(vendorSrc)) {
    cpSync(vendorSrc, pluginOut, { recursive: true });
  }
}

rmSync(rendererOut, { recursive: true, force: true });
console.log('plugins built.');
