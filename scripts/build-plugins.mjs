/**
 * Builds the built-in plugins (ADR-0044), no bundler involved:
 *
 *   plugins/<id>/main/index.ts     -> dist-electron/plugins/<id>/main/*.js   (CJS, Node16)
 *   plugins/<id>/renderer/*.ts     -> dist-plugins/<id>/renderer/*.js        (ESM, ES2022)
 *   plugins/<id>/plugin.json       -> dist-electron/plugins/<id>/plugin.json (manifest lives
 *                                    in the discovered rootDir)
 *   plugins/<id>/renderer/*.css    -> dist-plugins/<id>/renderer/*.css       (tsc copies nothing)
 *
 * The renderer output must contain no bare-specifier runtime imports — a
 * dynamic `import()` of `plugin://…` in the renderer would fail loudly on
 * one, which is exactly the failure mode we want (ADR-0044 rule 1).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
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

function copyStatic() {
  for (const entry of readdirSync(pluginsDir)) {
    const pluginDir = path.join(pluginsDir, entry);
    if (!statSync(pluginDir).isDirectory() || !existsSync(path.join(pluginDir, 'plugin.json'))) {
      continue;
    }
    // The manifest is read by discovery from the rootDir, which is the
    // main-process output root (dist-electron/plugins/<id>).
    mkdirSync(path.join(mainOut, 'plugins', entry), { recursive: true });
    cpSync(
      path.join(pluginDir, 'plugin.json'),
      path.join(mainOut, 'plugins', entry, 'plugin.json'),
    );
    // Stylesheets + any other renderer assets the ES-module output needs.
    const rendererSrc = path.join(pluginDir, 'renderer');
    const rendererDest = path.join(rendererOut, entry, 'renderer');
    if (existsSync(rendererSrc)) {
      mkdirSync(rendererDest, { recursive: true });
      for (const file of readdirSync(rendererSrc)) {
        if (file.endsWith('.css')) {
          cpSync(path.join(rendererSrc, file), path.join(rendererDest, file));
        }
      }
    }
  }
}

run(path.join(pluginsDir, 'tsconfig.main.json'));
run(path.join(pluginsDir, 'tsconfig.renderer.json'));
// The renderer tsconfig's rootDir is the repo root (it typechecks against
// `shared/`), so tsc emits `dist-plugins/plugins/<id>/renderer`. Normalize
// to `dist-plugins/<id>/renderer` — the layout the `plugin://` handler
// resolves — and drop the wrapper.
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
copyStatic();
console.log('plugins built.');
