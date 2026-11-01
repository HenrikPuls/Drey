import { describe, expect, it } from 'vitest';
import { dictationScript, encodePowerShell, startWindowsDictation, type ExecFileLike } from './dictation';

/**
 * req-75 W5b, T-0071: the Win+H press. `run` is injected — a spec must
 * never start PowerShell. The off-Windows refusal is the UI's hint
 * path ("Dictation did not start — press Win+H, or type.").
 */

/** A fake execFile: records the call, answers with the scripted error. */
function fakeExec(err: Error | null): { calls: Array<{ file: string; args: readonly string[] }>; run: ExecFileLike } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    run: (file, args, cb) => {
      calls.push({ file, args });
      cb(err);
    },
  };
}

describe('dictationScript / encodePowerShell', () => {
  it('presses and releases Win+H through keybd_event', () => {
    expect(dictationScript()).toContain('[Drey.Keys]::keybd_event(0x5B, 0, 0, [System.UIntPtr]::Zero)');
    expect(dictationScript()).toContain('[Drey.Keys]::keybd_event(0x5B, 0, 2, [System.UIntPtr]::Zero)');
    expect(dictationScript()).toContain('[Drey.Keys]::keybd_event(0x48, 0, 0, [System.UIntPtr]::Zero)');
    expect(dictationScript()).toContain('[Drey.Keys]::keybd_event(0x48, 0, 2, [System.UIntPtr]::Zero)');
  });

  it('encodes as base64 of UTF-16LE, round-tripping through the decoder', () => {
    const encoded = encodePowerShell(dictationScript());
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toBe(dictationScript());
  });
});

describe('startWindowsDictation', () => {
  it('runs PowerShell -EncodedCommand with the keybd script on Windows', async () => {
    const fake = fakeExec(null);
    const result = await startWindowsDictation('win32', fake.run);
    expect(result).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.file).toBe('powershell.exe');
    expect(fake.calls[0]!.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(dictationScript()),
    ]);
    const encoded = fake.calls[0]!.args[5];
    const decoded = typeof encoded === 'string' ? Buffer.from(encoded, 'base64').toString('utf16le') : '';
    expect(decoded).toContain('keybd_event');
    expect(decoded).toContain('0x5B');
    expect(decoded).toContain('0x48');
  });

  it('refuses off Windows without calling run', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const fake = fakeExec(null);
      await expect(startWindowsDictation(platform, fake.run)).resolves.toEqual({
        ok: false,
        error: 'Dictation needs Windows',
      });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it('reports a failed start instead of throwing', async () => {
    const fake = fakeExec(new Error('spawn ENOENT'));
    await expect(startWindowsDictation('win32', fake.run)).resolves.toEqual({
      ok: false,
      error: 'Dictation did not start: spawn ENOENT',
    });
  });
});
