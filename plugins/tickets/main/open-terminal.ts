/**
 * Opens the OS terminal with its working directory at an absolute
 * folder (T-0004: a ticket's work checkout). A deliberately minimal
 * twin of the base's `VaultManager.openTerminalIn` (plugins cannot
 * import `electron/`): same candidates, same detached + unref'd spawn
 * by ARG ARRAY with `cwd` — the path is never interpolated into a
 * shell string, and the terminal outlives the app. On Windows the
 * cmd fallback routes through `start`, because a detached child never
 * gets a console of its own.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

function launchTerminal(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd });
      child.once('error', () => resolve(false));
      child.once('spawn', () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Resolves once a terminal window is up at `dir` (which must exist). */
export async function openTerminalAt(dir: string): Promise<void> {
  if (!(await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false))) {
    throw new Error(`the folder does not exist: ${dir}`);
  }
  const candidates: Array<{ cmd: string; args: string[]; cwd?: string; label: string }> =
    process.platform === 'win32'
      ? [
          { cmd: 'wt.exe', args: ['-d', dir], label: 'Windows Terminal' },
          {
            cmd: process.env['ComSpec'] ?? 'cmd.exe',
            // The empty-string arg is `start`'s window-title placeholder,
            // keeping `cmd` from being read as the title.
            args: ['/c', 'start', '', 'cmd'],
            cwd: dir,
            label: 'cmd',
          },
        ]
      : process.platform === 'darwin'
        ? [{ cmd: 'open', args: ['-a', 'Terminal', dir], label: 'Terminal' }]
        : [
            { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`], label: 'gnome-terminal' },
            { cmd: 'konsole', args: ['--workdir', dir], label: 'konsole' },
            { cmd: 'kitty', args: ['--directory', dir], label: 'kitty' },
            { cmd: 'xdg-terminal-exec', args: [], cwd: dir, label: 'xdg-terminal-exec' },
          ];
  for (const candidate of candidates) {
    if (await launchTerminal(candidate.cmd, candidate.args, candidate.cwd)) {
      return;
    }
  }
  throw new Error(
    `no terminal found (tried ${candidates.map((c) => c.label).join(', ')}).`,
  );
}

/**
 * The console a started program runs in: what `runInNewConsole` needs
 * from a spawn (the spec injects a recorder). The real `spawn` fits.
 */
export type ConsoleSpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; detached: true; stdio: 'ignore'; windowsHide: boolean },
) => { once(event: 'error', listener: () => void): unknown; unref(): unknown };

/**
 * Runs one command line in a fresh OS console at `cwd` (req-75 W3 /
 * T-0057): "Launch this version" — the repo's `launch:` command from
 * repos.md, or the dev.ps1 default — so the started program outlives
 * Drey in its own window. The command line is handed to the terminal
 * as ONE argument (no `shell: true`, no string built from ticket
 * content — it comes from repos.md or the fixed default); `cwd` is the
 * spawn option, never interpolated.
 */
export function runInNewConsole(
  cwd: string,
  commandLine: string,
  spawnFn: ConsoleSpawnFn = spawn,
): void {
  const child =
    process.platform === 'win32'
      ? // `start "<title>" cmd /k <line>`: start opens the new console
        // window (the title placeholder keeps `cmd` from being read as
        // it), `/k` keeps it open after the command ends.
        spawnFn(process.env['ComSpec'] ?? 'cmd.exe', ['/c', 'start', path.basename(cwd), 'cmd.exe', '/k', commandLine], {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        })
      : process.platform === 'darwin'
        ? spawnFn('open', ['-a', 'Terminal', cwd], {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          })
        : spawnFn('x-terminal-emulator', ['-e', 'sh', '-c', commandLine], {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
  // Fire and forget: the only failure a spawn can report asynchronously
  // is an unfound binary — swallowed here so a launch never crashes the
  // app; the console window either opens or it does not.
  child.once('error', () => undefined);
  child.unref();
}
