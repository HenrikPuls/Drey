/**
 * Startup measurement harness (milestone 61): launches a packaged drey.exe
 * N times and reports wall-clock time from launch to the titlebar being
 * visible -- the same "app is usable" signal for old and new builds.
 * Usage: node measure-startup.mjs <path-to-drey.exe> [runs]
 */
import { _electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exe = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node measure-startup.mjs <drey.exe> [runs]');
  process.exit(1);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-measure-'));
const udd = path.join(base, 'profile');
fs.mkdirSync(udd, { recursive: true });
const vault = path.join(base, 'vault');
fs.mkdirSync(vault, { recursive: true });
for (let i = 1; i <= 30; i++) {
  fs.writeFileSync(path.join(vault, `note${i}.md`), `# Note ${i}\n\ncontent with #tag${i}\n`);
}
fs.writeFileSync(path.join(udd, 'vault-config.json'), JSON.stringify({ activeVaultPath: vault }));

// The fixtures' ELECTRON_RUN_AS_NODE dance: Electron checks existence.
const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

for (let run = 1; run <= runs; run++) {
  const t0 = Date.now();
  const app = await _electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${udd}`],
    env,
  });
  const window = await app.firstWindow({ timeout: 90_000 });
  await window.waitForSelector('app-titlebar .brand .mark', { timeout: 90_000 });
  const elapsed = Date.now() - t0;
  console.log(`run ${run}: ${elapsed} ms to titlebar visible`);
  await app.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));
}
fs.rmSync(base, { recursive: true, force: true });
