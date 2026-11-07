import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyLock, HOME_PREFIX, isEngineCommandLine, sweepLeftoverEngines } from './engine-sweep';

describe('classifyLock (D-43)', () => {
  it('owns a lock whose vault lies under test-results', () => {
    expect(
      classifyLock({ pid: 4242, vaultPath: 'E:\\projects\\Drey\\test-results\\board-issues-abc\\vault' }),
    ).toEqual({ kind: 'ours', pid: 4242 });
    expect(classifyLock({ pid: 7, vaultPath: '/tmp/repo/test-results/x/vault' })).toEqual({ kind: 'ours', pid: 7 });
  });

  it('never touches a lock that points at a real vault', () => {
    const verdict = classifyLock({ pid: 4242, vaultPath: 'E:\\projects\\drey-tickets' });
    expect(verdict.kind).toBe('foreign');
    // a folder merely named like it does not count as the segment
    expect(classifyLock({ pid: 1, vaultPath: 'E:\\my-test-results-archive\\vault' }).kind).toBe('foreign');
  });

  it('treats a missing or malformed lock as not ours to end', () => {
    expect(classifyLock(null)).toEqual({ kind: 'no-lock' });
    expect(classifyLock({ vaultPath: '/r/test-results/v' }).kind).toBe('foreign');
    expect(classifyLock({ pid: '4242', vaultPath: '/r/test-results/v' }).kind).toBe('foreign');
    expect(classifyLock({ pid: 0, vaultPath: '/r/test-results/v' }).kind).toBe('foreign');
    expect(classifyLock({ pid: 4242 }).kind).toBe('foreign');
  });
});

describe('isEngineCommandLine', () => {
  it('accepts only the engine entry', () => {
    expect(isEngineCommandLine('C:\\x\\electron.exe E:\\r\\dist-electron\\packages\\tickets-engine\\src\\server\\engine-main.js --vault v')).toBe(true);
    expect(isEngineCommandLine('node fleet/runner.js --root r')).toBe(false);
    expect(isEngineCommandLine(null)).toBe(false);
  });
});

describe('sweepLeftoverEngines', () => {
  it('removes dead homes, keeps foreign ones, and ends nothing that is not an engine', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-spec-'));
    try {
      const dead = path.join(tmp, `${HOME_PREFIX}dead`);
      fs.mkdirSync(path.join(dead, '.drey-engine'), { recursive: true });
      // a pid no process has: the lock is ours, the engine is gone
      fs.writeFileSync(path.join(dead, '.drey-engine', 'engine.lock'), JSON.stringify({ pid: 2_000_000_000, vaultPath: '/r/test-results/t/vault' }));

      const empty = path.join(tmp, `${HOME_PREFIX}empty`);
      fs.mkdirSync(empty);

      const foreign = path.join(tmp, `${HOME_PREFIX}foreign`);
      fs.mkdirSync(path.join(foreign, '.drey-engine'), { recursive: true });
      fs.writeFileSync(path.join(foreign, '.drey-engine', 'engine.lock'), JSON.stringify({ pid: process.pid, vaultPath: '/home/owner/tickets' }));

      // ours by the lock, alive, but this very test process -- not an engine
      const self = path.join(tmp, `${HOME_PREFIX}self`);
      fs.mkdirSync(path.join(self, '.drey-engine'), { recursive: true });
      fs.writeFileSync(path.join(self, '.drey-engine', 'engine.lock'), JSON.stringify({ pid: process.pid, vaultPath: '/r/test-results/t/vault' }));

      fs.mkdirSync(path.join(tmp, 'unrelated-dir'));

      const lines: string[] = [];
      const report = sweepLeftoverEngines({ tmpDir: tmp, log: (line) => lines.push(line) });

      expect(report.homes).toBe(4);
      expect(report.stopped).toEqual([]);
      expect(report.removed).toBe(2);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(empty)).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
      expect(fs.existsSync(self)).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'unrelated-dir'))).toBe(true);
      expect(report.skipped).toHaveLength(2);
      expect(report.skipped.find((s) => s.startsWith(`${HOME_PREFIX}foreign`))).toContain('outside test-results');
      expect(report.skipped.find((s) => s.startsWith(`${HOME_PREFIX}self`))).toContain('not an engine');
      expect(lines[0]).toContain('4 leftover home(s), 0 engine(s) ended, 2 home(s) removed, 2 skipped');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is silent and harmless on a temp dir that does not exist', () => {
    const lines: string[] = [];
    const report = sweepLeftoverEngines({ tmpDir: path.join(os.tmpdir(), 'sweep-spec-missing-' + process.pid), log: (l) => lines.push(l) });
    expect(report).toEqual({ homes: 0, stopped: [], skipped: [], removed: 0 });
    expect(lines).toEqual([]);
  });
});
