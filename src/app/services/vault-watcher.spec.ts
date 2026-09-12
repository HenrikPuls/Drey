import * as nodePath from 'node:path';
import { OwnWriteLedger } from '../../../electron/own-write-ledger';
import {
  ExternalVaultChanges,
  VaultChangeAnnouncer,
} from '../../../electron/vault-change-announcer';
import { MinimalFsWatcher, VaultWatcher } from '../../../electron/vault-watcher';

/**
 * `electron/vault-watcher.ts` takes the real chokidar watcher in through a
 * factory (ADR-0045), so the tests drive a fake `MinimalFsWatcher` and
 * assert what lands on the announcer. Fake timers advance the debounce.
 */

class FakeWatcher implements MinimalFsWatcher {
  readonly closed = { value: false };
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  close(): Promise<void> {
    this.closed.value = true;
    return Promise.resolve();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  ready(): void {
    this.emit('ready');
  }

  file(kind: 'add' | 'change' | 'unlink', absPath: string, mtimeMs?: number): void {
    this.emit(kind, absPath, mtimeMs === undefined ? undefined : { mtimeMs });
  }
}

describe('VaultWatcher', () => {
  let root: string;
  let watcher: FakeWatcher | null;
  let factoryRoots: string[];
  let enabled: boolean;
  let ledger: OwnWriteLedger;
  let announced: ExternalVaultChanges[];
  let fullRefreshes: number;
  let warnings: string[];
  let subject: VaultWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    root = nodePath.resolve('/vault');
    watcher = null;
    factoryRoots = [];
    enabled = true;
    ledger = new OwnWriteLedger();
    announced = [];
    fullRefreshes = 0;
    warnings = [];
    subject = new VaultWatcher({
      getRoot: () => root,
      isEnabled: () => enabled,
      ledger,
      announcer: {
        announceFullRefresh: () => {
          fullRefreshes++;
        },
        announceExternal: (changes) => {
          announced.push(changes);
        },
      } as VaultChangeAnnouncer,
      watchFactory: (watchRoot) => {
        factoryRoots.push(watchRoot);
        watcher = new FakeWatcher();
        return watcher;
      },
      log: (message, level) => {
        if (level === 'warn') {
          warnings.push(message);
        }
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts the watcher, fires chokidar's `ready`, returns the fake. */
  async function started(): Promise<FakeWatcher> {
    await subject.syncFromConfig();
    if (!watcher) {
      throw new Error('watchFactory was not called');
    }
    watcher.ready();
    return watcher;
  }

  function pathOf(...segments: string[]): string {
    return nodePath.join(root, ...segments);
  }

  it('does nothing while disabled', async () => {
    enabled = false;
    await subject.syncFromConfig();
    expect(subject.isRunning()).toBe(false);
    expect(factoryRoots).toEqual([]);
  });

  it('follows enabled -> disabled -> enabled through syncFromConfig', async () => {
    await subject.syncFromConfig();
    expect(subject.isRunning()).toBe(true);
    expect(factoryRoots).toEqual([root]);

    enabled = false;
    await subject.syncFromConfig();
    expect(subject.isRunning()).toBe(false);
    expect(watcher?.closed.value).toBe(true);

    enabled = true;
    await subject.syncFromConfig();
    expect(subject.isRunning()).toBe(true);
    expect(factoryRoots).toEqual([root, root]);
  });

  it('is a no-op when the effective root is unchanged', async () => {
    await subject.syncFromConfig();
    await subject.syncFromConfig();
    await subject.syncFromConfig();
    expect(factoryRoots).toEqual([root]);
  });

  it('drops events that arrive before chokidar is ready', async () => {
    await subject.syncFromConfig();
    watcher!.file('change', pathOf('a.md'), 1);
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([]);
  });

  it('coalesces a burst into one round', async () => {
    const w = await started();
    w.file('add', pathOf('a.md'), 1);
    w.file('change', pathOf('b.md'), 2);
    w.file('change', pathOf('b.md'), 3);
    vi.advanceTimersByTime(299);
    expect(announced).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(announced).toEqual([{ changedPaths: ['a.md', 'b.md'], deletedPaths: [] }]);
  });

  it('drops the app\'s own echoes via the ledger', async () => {
    const w = await started();
    ledger.recordWrite('a.md', 42);
    w.file('change', pathOf('a.md'), 42);
    ledger.recordStructural('gone.md');
    w.file('unlink', pathOf('gone.md'));
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([]);
  });

  it('reports an external delete as a per-file delete event', async () => {
    const w = await started();
    w.file('unlink', pathOf('notes/a.md'));
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([{ changedPaths: [], deletedPaths: ['notes/a.md'] }]);
  });

  it('expands a deleted folder into its child file events, never the folder path', async () => {
    const w = await started();
    w.file('unlink', pathOf('notes/a.md'));
    w.file('unlink', pathOf('notes/b.md'));
    w.emit('unlinkDir', pathOf('notes'));
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([
      { changedPaths: [], deletedPaths: ['notes/a.md', 'notes/b.md'] },
    ]);
  });

  it('pushes a tree-only round for non-Markdown changes', async () => {
    const w = await started();
    w.file('change', pathOf('attachments/pic.png'), 1);
    w.emit('addDir', pathOf('new-folder'));
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([{ changedPaths: [], deletedPaths: [] }]);
  });

  it('last event wins when a path flips between changed and deleted', async () => {
    const w = await started();
    w.file('unlink', pathOf('a.md'));
    w.file('add', pathOf('a.md'), 1);
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([{ changedPaths: ['a.md'], deletedPaths: [] }]);
  });

  it('ignores paths outside the vault root', async () => {
    const w = await started();
    w.file('change', pathOf('..', 'elsewhere.md'), 1);
    vi.advanceTimersByTime(300);
    expect(announced).toEqual([]);
  });

  it('stops on a watcher error and logs a warning', async () => {
    const w = await started();
    w.emit('error', new Error('root vanished'));
    expect(subject.isRunning()).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
