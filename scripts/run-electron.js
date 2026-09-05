'use strict';

// Thin launcher used by the "electron" npm script instead of calling the
// `electron` CLI directly.
//
// Why: `ELECTRON_RUN_AS_NODE` is present (sometimes even set to an empty
// string) in some parent shells -- e.g. a terminal spawned from an
// Electron-based host application. Electron only checks whether the key
// EXISTS, not whether it's truthy, so `cross-env ELECTRON_RUN_AS_NODE=`
// does not clear it: it makes Electron start as a plain Node process
// instead of bootstrapping the app (require('electron') then resolves to
// this package's path-string helper instead of the real API, and
// `app.whenReady` is undefined). Deleting the key before spawning is the
// only reliable fix, and env vars can only be deleted on the *child's*
// environment object, not unset via a shell-portable one-liner in
// package.json -- hence this small script.

const { spawn } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..'),
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
