/**
 * The Electron leg of `npm run dev`: builds `dist-electron/`, starts
 * Electron against the dev server, and from then on REBUILDS AND RESTARTS
 * on every change under `electron/`, `shared/` or `plugins/`.
 *
 * Why: `ng serve` hot-reloads the renderer, but the main process, the
 * preload and the plugins run from `dist-electron/`. Built once, they went
 * stale the moment one of their sources changed, and since `shared/`
 * compiles into both sides the two then disagreed about the IPC contract
 * at runtime while `tsc` was clean (docs/11, "Environment gotchas").
 *
 * What is rebuilt follows from where the change is:
 *
 *   electron/**  -> main process + preload bundle
 *   plugins/**   -> plugins
 *   shared/**    -> both (it is compiled into each)
 *
 * The restart is a normal quit, not a kill: the app is asked over the
 * child's IPC channel (`DEV_RESTART_MESSAGE`, handled in electron/main.ts
 * in dev only), so unsaved tabs raise the usual exit prompt and the session
 * is restored afterwards. Cancelling that prompt keeps the old process
 * running; it is replaced as soon as it does close. A failed build restarts
 * nothing and waits for the next change. Closing the window yourself ends
 * the dev session, as before.
 */
import chokidar from 'chokidar';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const electronPath = require('electron');

/** Keep in step with `DEV_RESTART_MESSAGE` in electron/main.ts. */
const DEV_RESTART_MESSAGE = 'drey-dev:restart';
const DEBOUNCE_MS = 300;

const STEPS = {
  electron: [
    [tsc, '-p', path.join('electron', 'tsconfig.json')],
    [path.join('scripts', 'bundle-preload.mjs')],
  ],
  plugins: [[path.join('scripts', 'build-plugins.mjs')]],
};

function log(message) {
  console.log(`[dev] ${message}`);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/** Runs the build steps of `targets` in order; false as soon as one fails. */
async function build(targets) {
  for (const target of ['electron', 'plugins']) {
    if (!targets.has(target)) {
      continue;
    }
    for (const step of STEPS[target]) {
      if (!(await runNode(step))) {
        return false;
      }
    }
  }
  return true;
}

/** Which build a changed file belongs to; an empty list for files that need none. */
function targetsFor(file) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  if (relative.endsWith('.spec.ts') || relative.startsWith('electron/testing/')) {
    return [];
  }
  if (relative.startsWith('plugins/')) {
    return ['plugins'];
  }
  if (relative.startsWith('electron/')) {
    return ['electron'];
  }
  return ['electron', 'plugins'];
}

let app = null;
let restartWanted = false;

function startApp() {
  const env = { ...process.env, DREY_RENDERER_URL: process.env.DREY_RENDERER_URL || 'http://localhost:4200' };
  // See scripts/run-electron.js: the key's mere presence makes Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env,
    cwd: repoRoot,
  });
  app.on('exit', (code, signal) => {
    app = null;
    if (restartWanted) {
      restartWanted = false;
      log('restarting Electron');
      startApp();
      return;
    }
    void watcher.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function restartApp() {
  if (app === null) {
    startApp();
    return;
  }
  restartWanted = true;
  log('build finished, asking Electron to quit (unsaved tabs will ask first)');
  app.send(DEV_RESTART_MESSAGE, (error) => {
    if (error) {
      log(`could not reach Electron (${error.message}); close the window to restart`);
    }
  });
}

const pending = new Set();
let timer = null;
let building = false;

async function rebuild() {
  if (building || pending.size === 0) {
    return;
  }
  building = true;
  const targets = new Set(pending);
  pending.clear();
  log(`change detected, rebuilding ${[...targets].join(' + ')}`);
  const ok = await build(targets);
  building = false;
  if (pending.size > 0) {
    // Something changed while building: build that too before restarting.
    if (!ok) {
      for (const target of targets) {
        pending.add(target);
      }
    }
    void rebuild();
    return;
  }
  if (ok) {
    restartApp();
  } else {
    log('build failed, Electron keeps running the previous build');
  }
}

const watcher = chokidar.watch(['electron', 'shared', 'plugins'], {
  cwd: repoRoot,
  ignoreInitial: true,
  // Fetched third-party files (the draw.io web app): thousands of files that never change by hand.
  ignored: (file) => /[\\/]plugins[\\/][^\\/]+[\\/]vendor([\\/]|$)/.test(file),
});

watcher.on('all', (_event, file) => {
  const targets = targetsFor(path.resolve(repoRoot, file));
  if (targets.length === 0) {
    return;
  }
  for (const target of targets) {
    pending.add(target);
  }
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), DEBOUNCE_MS);
});

if (!(await runNode([path.join('scripts', 'stamp-build.mjs')])) || !(await build(new Set(['electron', 'plugins'])))) {
  await watcher.close();
  process.exit(1);
}
log('watching electron/, shared/ and plugins/ — a change rebuilds and restarts Electron');
startApp();
