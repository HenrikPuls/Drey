/**
 * Starts Windows dictation (req-75 W5b, T-0071): one Win+H key press
 * through PowerShell. Drey runs no speech recognition of its own
 * (req-11 stays excluded) — the OS's dictation types into whatever
 * field has focus, so the renderer focuses Description before
 * invoking the `'dictate'` IPC.
 *
 * The script travels as `-EncodedCommand` (base64 of UTF-16LE): it
 * holds double quotes, and Windows argument quoting through Node would
 * mangle them — base64 needs no quoting at all. `execFile` passes the
 * argument array to CreateProcess verbatim: no shell, no string
 * concatenation into a command line.
 */

/** The `execFile` shape this module needs — injected so the spec never
 *  starts PowerShell. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  cb: (err: Error | null) => void,
) => void;

/**
 * The PowerShell script that presses and releases Win+H through
 * user32 `keybd_event` — `0x5B` is the left Windows key, `0x48` is H,
 * flag `2` is key up. Keep byte-exact: the docs and the spec quote it.
 */
export function dictationScript(): string {
  return [
    `Add-Type -Namespace Drey -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'`,
    `[Drey.Keys]::keybd_event(0x5B, 0, 0, [System.UIntPtr]::Zero)`,
    `[Drey.Keys]::keybd_event(0x48, 0, 0, [System.UIntPtr]::Zero)`,
    `[Drey.Keys]::keybd_event(0x48, 0, 2, [System.UIntPtr]::Zero)`,
    `[Drey.Keys]::keybd_event(0x5B, 0, 2, [System.UIntPtr]::Zero)`,
  ].join('\n');
}

/** PowerShell's `-EncodedCommand` form: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Starts Windows dictation. Refuses off Windows; never throws. */
export function startWindowsDictation(
  platform: NodeJS.Platform,
  run: ExecFileLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'Dictation needs Windows' });
  }
  return new Promise((resolve) => {
    try {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(dictationScript())], (err) => {
        resolve(err === null ? { ok: true } : { ok: false, error: `Dictation did not start: ${err.message}` });
      });
    } catch (err) {
      resolve({ ok: false, error: `Dictation did not start: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
