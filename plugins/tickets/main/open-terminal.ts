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
