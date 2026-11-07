import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorePathReporter, parseNameStatus, type StorePathChange } from './store-path-report';

describe('parseNameStatus', () => {
  it('splits additions and edits from deletions, paths as git writes them', () => {
    expect(parseNameStatus('A\0tickets/t/0000/t-2/ticket.md\0M\0tickets/t/0000/t-1/ticket.md\0D\0tickets/t/0000/t-3/ticket.md\0')).toEqual({
      changed: ['tickets/t/0000/t-2/ticket.md', 'tickets/t/0000/t-1/ticket.md'],
      deleted: ['tickets/t/0000/t-3/ticket.md'],
    });
    expect(parseNameStatus('')).toEqual({ changed: [], deleted: [] });
  });
});

describe('StorePathReporter (D-28), a real checkout', () => {
  let dir: string;
  const reports: StorePathChange[] = [];
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  };
  const commit = (file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', `write ${file}`);
  };
  const reporter = (): StorePathReporter => new StorePathReporter(dir, (change) => reports.push(change), () => undefined);

  beforeEach(() => {
    reports.length = 0;
    dir = mkdtempSync(path.join(tmpdir(), 'store-paths-'));
    git('init', '-q');
    git('config', 'user.email', 'a@b.invalid');
    git('config', 'user.name', 'a');
    commit('tickets/t/0000/t-1/ticket.md', 'one');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a new ticket and an edit made by anyone, once', async () => {
    const paths = reporter();
    await paths.start();
    expect(reports).toEqual([]);

    commit('tickets/t/0000/t-2/ticket.md', 'two');
    await paths.report();
    expect(reports).toEqual([{ checkout: dir, changed: ['tickets/t/0000/t-2/ticket.md'], deleted: [] }]);

    await paths.report();
    expect(reports).toHaveLength(1);

    commit('tickets/t/0000/t-1/ticket.md', 'one, edited');
    await paths.report();
    expect(reports[1]?.changed).toEqual(['tickets/t/0000/t-1/ticket.md']);
  });

  it('reports a removed file as deleted', async () => {
    const paths = reporter();
    await paths.start();
    git('rm', '-q', 'tickets/t/0000/t-1/ticket.md');
    git('commit', '-q', '-m', 'remove');
    await paths.report();
    expect(reports).toEqual([{ checkout: dir, changed: [], deleted: ['tickets/t/0000/t-1/ticket.md'] }]);
  });

  it('a report during a report runs after it and misses nothing', async () => {
    const paths = reporter();
    await paths.start();
    commit('tickets/t/0000/t-2/ticket.md', 'two');
    const first = paths.report();
    commit('tickets/t/0000/t-3/ticket.md', 'three');
    void paths.report();
    await first;
    await vi.waitFor(() => {
      expect(reports.flatMap((r) => r.changed)).toContain('tickets/t/0000/t-3/ticket.md');
    }, 5_000);
  });
});

describe('StorePathReporter, git failing', () => {
  it('logs, reports nothing and recovers on the next round', async () => {
    let fail = true;
    const log = vi.fn();
    const reports: StorePathChange[] = [];
    let head = 'a';
    const paths = new StorePathReporter('/c', (change) => reports.push(change), log, (args) => {
      if (fail) {
        return Promise.reject(new Error('no git'));
      }
      return Promise.resolve(args[0] === 'rev-parse' ? head : 'M\0x.md\0');
    });
    await paths.report();
    expect(log).toHaveBeenCalledOnce();
    fail = false;
    await paths.report(); // the first HEAD it can read is the baseline
    head = 'b';
    await paths.report();
    expect(reports).toEqual([{ checkout: '/c', changed: ['x.md'], deleted: [] }]);
  });
});
