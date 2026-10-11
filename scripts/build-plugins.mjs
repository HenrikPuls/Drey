/**
 * Builds the built-in plugins (ADR-0044). ONE output tree per plugin —
 * `dist-electron/plugins/<id>/` holds the manifest, the CJS main side and
 * the renderer bundle — because `plugin://` resolves every URL
 * root-relative against that one directory:
 *
 *   plugins/<id>/main/*.ts          -> dist-electron/plugins/<id>/main/*.js    (tsc, CJS)
 *   plugins/<id>/shared/*.ts        -> dist-electron/plugins/<id>/shared/*.js  (tsc, CJS, for main/)
 *   plugins/<id>/renderer/index.ts  -> dist-electron/plugins/<id>/renderer/index.js (esbuild, one ES module)
 *   plugins/<id>/plugin.json        -> dist-electron/plugins/<id>/plugin.json
 *   plugins/<id>/renderer/*.css     -> dist-electron/plugins/<id>/renderer/*.css
 *
 * The renderer is bundled (ADR-0044, later change) so it can use the same
 * `shared/` modules as the base and the plugin's main side instead of
 * keeping copies of them: `plugin://` serves nothing outside the plugin's
 * own directory, so whatever the renderer imports has to end up inside its
 * one file. `tsc` stays the typecheck for it (`noEmit`).
 *
 * A bundler would also inline a package without complaint, and a second
 * copy of `@codemirror/*` breaks the editor silently (ADR-0044 rule 1).
 * `onlyOwnSources` therefore fails the build on any runtime import that is
 * not a relative path into the plugin's own folder or the repo's `shared/`.
 * Type-only imports never get that far — esbuild drops them while parsing.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const pluginsDir = path.join(repoRoot, 'plugins');
const sharedDir = path.join(repoRoot, 'shared');
const mainOut = path.join(repoRoot, 'dist-electron');

function run(config) {
  const result = spawnSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`tsc failed for ${config}`);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Fails the build on a runtime import from anywhere but the plugin itself or `shared/`. */
function onlyOwnSources(pluginDir) {
  return {
    name: 'only-own-sources',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          return null;
        }
        const from = path.relative(repoRoot, args.importer);
        if (!args.path.startsWith('.')) {
          return {
            errors: [
              {
                text: `${from} imports the package "${args.path}" at runtime. A plugin renderer takes what it needs from the host through api.* and imports packages as types only (ADR-0044 rule 1).`,
              },
            ],
          };
        }
        const target = path.resolve(args.resolveDir, args.path);
        if (!isInside(pluginDir, target) && !isInside(sharedDir, target)) {
          return {
            errors: [
              {
                text: `${from} imports "${args.path}", which is neither inside its own plugin folder nor in shared/.`,
              },
            ],
          };
        }
        return null;
      });
    },
  };
}

run(path.join(pluginsDir, 'tsconfig.main.json'));
// Typecheck only: the renderer's JavaScript comes from esbuild below.
run(path.join(pluginsDir, 'tsconfig.renderer.json'));

for (const entry of readdirSync(pluginsDir)) {
  const pluginDir = path.join(pluginsDir, entry);
  if (!statSync(pluginDir).isDirectory() || !existsSync(path.join(pluginDir, 'plugin.json'))) {
    continue;
  }
  const pluginOut = path.join(mainOut, 'plugins', entry);
  mkdirSync(pluginOut, { recursive: true });
  // The manifest is read by discovery from the rootDir.
  cpSync(path.join(pluginDir, 'plugin.json'), path.join(pluginOut, 'plugin.json'));

  const rendererSrc = path.join(pluginDir, 'renderer');
  const rendererEntry = path.join(rendererSrc, 'index.ts');
  if (existsSync(rendererEntry)) {
    await build({
      entryPoints: [rendererEntry],
      outfile: path.join(pluginOut, 'renderer', 'index.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      sourcemap: true,
      logLevel: 'warning',
      plugins: [onlyOwnSources(pluginDir)],
    });
  }
  // Static assets the bundler does not emit (stylesheets): copy explicitly.
  if (existsSync(rendererSrc)) {
    for (const file of readdirSync(rendererSrc)) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) {
        const dest = path.join(pluginOut, 'renderer');
        mkdirSync(dest, { recursive: true });
        cpSync(path.join(rendererSrc, file), path.join(dest, file));
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

console.log('plugins built.');
