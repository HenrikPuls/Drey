import { describe, expect, it } from 'vitest';

import { TicketStoreError } from '../ports/ticket-store';
import {
  assertDkVersion,
  compareVersions,
  decodeEnvelope,
  DK_EXIT_KINDS,
  DkProcess,
  MIN_DK_VERSION,
  parseDkVersion,
  type ExecFn,
  type ExecResult,
} from './dk-process';

const ok = (data: unknown): ExecResult => ({ stdout: JSON.stringify({ schema_version: 1, data }), stderr: '', code: 0, failure: null });
const fail = (code: number, kind: string, message = 'boom'): ExecResult => ({
  stdout: JSON.stringify({ schema_version: 1, error: { kind, exit_code: code, message } }),
  stderr: `dricket: ${message}\n`,
  code,
  failure: null,
});

interface Call {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number | null;
}

/** A scripted exec: `--version` answers the given text, every other call the next result. */
function scripted(version: string, results: ExecResult[]): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...results];
  const exec: ExecFn = (_file, args, options) => {
    if (args[0] === '--version') {
      return Promise.resolve({ stdout: `version: ${version}\ncommit: none\ndate: unknown\n`, stderr: '', code: 0, failure: null });
    }
    calls.push({ args, env: options.env, timeoutMs: options.timeoutMs });
    return Promise.resolve(queue.shift() ?? ok({}));
  };
  return { exec, calls };
}

describe('version gate', () => {
  it('parses and compares versions', () => {
    expect(parseDkVersion('v0.5.0')).toEqual([0, 5, 0]);
    expect(parseDkVersion('version: v1.12.3')).toEqual([1, 12, 3]);
    expect(parseDkVersion('dev')).toBeNull();
    expect(compareVersions([0, 4, 0], [0, 5, 0])).toBe(-1);
    expect(compareVersions([0, 10, 0], [0, 5, 0])).toBe(1);
    expect(compareVersions([0, 5, 0], [0, 5, 0])).toBe(0);
  });

  it('refuses an old dk with a clear error naming both versions and the path', () => {
    expect(() => assertDkVersion('v0.4.0', 'C:\\dk.exe')).toThrow(/dk 0\.4\.0 at C:\\dk\.exe is too old: Drey needs dk 0\.6\.0 or newer/);
    expect(() => assertDkVersion('v0.4.0', 'dk')).toThrow(expect.objectContaining({ kind: 'too-old' }));
    expect(() => assertDkVersion('v0.5.0', 'dk')).toThrow(expect.objectContaining({ kind: 'too-old' }));
    expect(() => assertDkVersion(`v${MIN_DK_VERSION}`, 'dk')).not.toThrow();
    expect(() => assertDkVersion('v0.6.1', 'dk')).not.toThrow();
    expect(() => assertDkVersion('dev', 'dk')).not.toThrow();
    expect(() => assertDkVersion('garbage', 'dk')).toThrow(TicketStoreError);
  });

  it('gates the first call and never reaches the command for an old dk', async () => {
    const { exec, calls } = scripted('v0.4.0', [ok({})]);
    const dk = new DkProcess({ bin: 'dk', store: '/s-old', exec });
    await expect(dk.call(['ls'], { write: false })).rejects.toMatchObject({ kind: 'too-old' });
    expect(calls).toEqual([]);
  });
});

describe('exit code table', () => {
  it('covers 1, 2 and 10-19', () => {
    expect(DK_EXIT_KINDS).toEqual({
      1: 'error',
      2: 'usage',
      10: 'not-found',
      11: 'claimed',
      12: 'conflict',
      13: 'claim-lost',
      14: 'invalid',
      15: 'network',
      16: 'too-old',
      17: 'forbidden',
      18: 'quota',
      19: 'secret',
    });
  });

  it.each([
    [10, 'not-found'],
    [11, 'claimed'],
    [12, 'conflict'],
    [13, 'claim-lost'],
    [14, 'invalid'],
    [15, 'network'],
    [16, 'too-old'],
  ] as const)('exit %i without an envelope is %s', (code, kind) => {
    expect(() => decodeEnvelope({ stdout: '', stderr: 'dricket: nope\n', code, failure: null })).toThrow(
      expect.objectContaining({ kind, exitCode: code, message: 'dricket: nope' }),
    );
  });

  it('prefers the envelope kind, and folds outcome-unknown into network', () => {
    expect(() => decodeEnvelope(fail(15, 'outcome-unknown', 'push result unknown'))).toThrow(
      expect.objectContaining({ kind: 'network', exitCode: 15, message: 'push result unknown' }),
    );
  });

  it('refuses a schema_version it does not know and non-envelope output', () => {
    expect(() => decodeEnvelope({ stdout: '{"schema_version":2,"data":{}}', stderr: '', code: 0, failure: null })).toThrow(/schema_version 2/);
    expect(() => decodeEnvelope({ stdout: 'hello', stderr: '', code: 0, failure: null })).toThrow(/does not understand/);
  });
});

describe('DkProcess', () => {
  it('passes --json first, the actor as DK_OWNER and the store as DK_STORE', async () => {
    const { exec, calls } = scripted('v0.6.0', [ok({ tickets: null })]);
    const dk = new DkProcess({ bin: 'dk', store: '/s-env', dataDir: '/data', env: { PATH: 'x' }, exec });
    await dk.call(['ls'], { write: false, actor: 'ben.run-1' });
    expect(calls[0]!.args).toEqual(['--json', 'ls']);
    expect(calls[0]!.env).toMatchObject({ DK_OWNER: 'ben.run-1', DK_STORE: '/s-env', DK_DATA_DIR: '/data', NO_COLOR: '1', PATH: 'x' });
  });

  it('times reads out but never writes', async () => {
    const { exec, calls } = scripted('v0.6.0', [ok({}), ok({})]);
    const dk = new DkProcess({ bin: 'dk', store: '/s-timeout', readTimeoutMs: 1234, exec });
    await dk.call(['ls'], { write: false });
    await dk.call(['claim', 't-1'], { write: true, actor: 'a' });
    expect(calls.map((c) => c.timeoutMs)).toEqual([1234, null]);
  });

  it('serialises writes per repository and lets another repository run alongside', async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const exec: ExecFn = async (_f, args) => {
      if (args[0] === '--version') {
        return { stdout: 'version: v0.6.0\n', stderr: '', code: 0, failure: null };
      }
      const key = args[args.length - 1]!;
      log.push(`start ${key}`);
      await new Promise<void>((resolve) => gates.set(key, resolve));
      log.push(`end ${key}`);
      return ok({});
    };
    const a = new DkProcess({ bin: 'dk', store: '/repo-a', exec });
    const a2 = new DkProcess({ bin: 'dk', store: '/repo-a', exec });
    const b = new DkProcess({ bin: 'dk', store: '/repo-b', exec });
    const p1 = a.call(['claim', 'one'], { write: true });
    const p2 = a2.call(['claim', 'two'], { write: true });
    const p3 = b.call(['claim', 'three'], { write: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['start one', 'start three']);
    gates.get('one')!();
    await p1;
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toContain('start two');
    gates.get('two')!();
    gates.get('three')!();
    await Promise.all([p2, p3]);
  });

  it('names a missing dk and a cancelled call', async () => {
    const missing: ExecFn = () => Promise.resolve({ stdout: '', stderr: '', code: null, failure: 'ENOENT' });
    await expect(new DkProcess({ bin: 'nope', store: '/s-m', exec: missing }).call(['ls'], { write: false })).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('was not found'),
    });
    const aborting: ExecFn = (_f, args) =>
      Promise.resolve(
        args[0] === '--version'
          ? { stdout: 'version: v0.6.0\n', stderr: '', code: 0, failure: null }
          : { stdout: '', stderr: '', code: null, failure: 'ABORT_ERR' },
      );
    await expect(new DkProcess({ bin: 'dk', store: '/s-c', exec: aborting }).call(['ls'], { write: true })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
