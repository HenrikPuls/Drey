import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fleetBuildStamp, formatStamp, isOlderBuild, isStaleDaemon, parseStamp, requireClosure } from './build-stamp';

describe('isOlderBuild', () => {
  const older = '2026-10-18T10:00:00.000Z';
  const newer = '2026-10-18T12:00:00.000Z';

  it('retires a daemon whose build is older than this one', () => {
    expect(isOlderBuild(older, newer)).toBe(true);
  });

  it('keeps a newer daemon — two checkouts must not retire each other', () => {
    expect(isOlderBuild(newer, older)).toBe(false);
  });

  it('keeps an equal stamp (same build, no churn)', () => {
    expect(isOlderBuild(newer, newer)).toBe(false);
  });

  it('keeps the daemon when either stamp is unparsable', () => {
    expect(isOlderBuild('not-a-date', newer)).toBe(false);
    expect(isOlderBuild(older, 'not-a-date')).toBe(false);
  });

  it('reads the date half of a hashed stamp', () => {
    expect(isOlderBuild(formatStamp(older, 'aaaa'), formatStamp(newer, 'bbbb'))).toBe(true);
  });
});

describe('isStaleDaemon', () => {
  const older = '2026-10-18T10:00:00.000Z';
  const newer = '2026-10-18T12:00:00.000Z';

  it('retires a daemon that reports no build stamp (it predates the stamp)', () => {
    expect(isStaleDaemon(undefined, formatStamp(newer, 'aaaa'))).toBe(true);
  });

  it('keeps a stamp-less daemon when this build has no stamp to compare', () => {
    expect(isStaleDaemon(undefined, null)).toBe(false);
  });

  it('keeps a daemon on the same code, however much newer the rebuilt files are (req-51)', () => {
    expect(isStaleDaemon(formatStamp(older, 'aaaa'), formatStamp(newer, 'aaaa'))).toBe(false);
  });

  it('retires an older daemon on other code, keeps a newer one', () => {
    expect(isStaleDaemon(formatStamp(older, 'aaaa'), formatStamp(newer, 'bbbb'))).toBe(true);
    expect(isStaleDaemon(formatStamp(newer, 'aaaa'), formatStamp(older, 'bbbb'))).toBe(false);
  });

  it('compares a pre-req-51 mtime stamp by date', () => {
    expect(parseStamp(older)).toEqual({ builtAt: older, hash: null });
    expect(isStaleDaemon(older, formatStamp(newer, 'aaaa'))).toBe(true);
  });
});

describe('fleetBuildStamp', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-stamp-'));
    await fsp.mkdir(path.join(dir, 'main', 'fleet'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'shared'), { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'main', 'fleet', 'runner.js'),
      'const a = require("./runs");\nconst fs = require("node:fs");\nconst y = require("yaml");\n',
    );
    await fsp.writeFile(path.join(dir, 'main', 'fleet', 'runs.js'), 'const t = require("../ticket-files");\n');
    await fsp.writeFile(path.join(dir, 'main', 'ticket-files.js'), 'const s = require("../shared");\n');
    await fsp.writeFile(path.join(dir, 'shared', 'index.js'), 'exports.x = 1;\n');
    await fsp.writeFile(path.join(dir, 'main', 'unrelated.js'), 'exports.y = 2;\n');
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const entry = (): string => path.join(dir, 'main', 'fleet', 'runner.js');

  it('follows relative requires only, into siblings and folder indexes', async () => {
    const files = (await requireClosure(entry())).map((f) => path.relative(dir, f).split(path.sep).join('/'));
    expect(files.sort()).toEqual(['main/fleet/runner.js', 'main/fleet/runs.js', 'main/ticket-files.js', 'shared/index.js']);
  });

  it('a rebuild that rewrites the files unchanged keeps the hash', async () => {
    const before = parseStamp(await fleetBuildStamp(entry()));
    const later = new Date(Date.now() + 60_000);
    for (const file of await requireClosure(entry())) {
      await fsp.writeFile(file, await fsp.readFile(file));
      await fsp.utimes(file, later, later);
    }
    const after = parseStamp(await fleetBuildStamp(entry()));
    expect(after.hash).toBe(before.hash);
    expect(Date.parse(after.builtAt)).toBeGreaterThan(Date.parse(before.builtAt));
  });

  it('a change anywhere in the closure changes the hash; one outside it does not', async () => {
    const before = parseStamp(await fleetBuildStamp(entry())).hash;
    await fsp.writeFile(path.join(dir, 'main', 'unrelated.js'), 'exports.y = 3;\n');
    expect(parseStamp(await fleetBuildStamp(entry())).hash).toBe(before);
    await fsp.writeFile(path.join(dir, 'shared', 'index.js'), 'exports.x = 2;\n');
    expect(parseStamp(await fleetBuildStamp(entry())).hash).not.toBe(before);
  });
});
