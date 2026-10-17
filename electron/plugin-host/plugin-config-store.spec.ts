import { describe, expect, it } from 'vitest';
import { PluginConfigStore, type ConfigIo } from './plugin-config-store';

/**
 * The plugin config store's contract, against a scripted IO seam: the
 * CI failure of 2026-10-17 (drawio "PNG on request" e2e) came from the
 * old read-modify-write racing itself — a read that started while a
 * write was pending re-cached the stale disk state over the newer
 * value, and the setting was gone. Rounds are serialized per plugin id
 * now, and a set publishes to the cache before it touches the disk.
 */

interface PendingRead {
  readonly path: string;
  resolve: (text: string) => void;
}

/** IO fake whose reads stay pending until the test releases them. */
function deferredIo(files: Map<string, string>): {
  io: ConfigIo;
  pendingReads: PendingRead[];
  writes: string[];
  releaseAll(): void;
} {
  const pendingReads: PendingRead[] = [];
  const writes: string[] = [];
  const io: ConfigIo = {
    readFile: async (file) => {
      const existing = files.get(file);
      if (existing !== undefined) {
        return existing;
      }
      return new Promise<string>((resolve) => {
        pendingReads.push({ path: file, resolve: (text) => {
          files.set(file, text);
          resolve(text);
        } });
      });
    },
    writeFile: async (file, text) => {
      writes.push(file);
      files.set(file, text);
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      const text = files.get(from);
      if (text !== undefined) {
        files.set(to, text);
        files.delete(from);
      }
    },
  };
  return { io, pendingReads, writes, releaseAll: () => {
    for (const pending of [...pendingReads].reverse()) {
      pending.resolve(files.get(pending.path) ?? '{}');
    }
    pendingReads.length = 0;
  } };
}

const configOf = (values: Record<string, unknown>): string => JSON.stringify(values, null, 2);

/** Lets every pending microtask (a round's start, its readFile call) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('PluginConfigStore', () => {
  it('a read racing a cold-store set still sees the set value afterwards', async () => {
    const files = new Map<string, string>();
    const { io, pendingReads, releaseAll } = deferredIo(files);
    const store = new PluginConfigStore('\\root', io);

    // The get goes out first (cold cache, its disk read pending), the
    // set lands while it waits. The queue serializes them; the set's
    // newer value must survive the racing read.
    const getP = store.get<string>('drawio', 'newDiagramFormat');
    await settle(); // let the get's round claim the queue and start its read
    const setP = store.set('drawio', 'newDiagramFormat', 'png');
    await settle();
    expect(pendingReads.length).toBe(1); // only the get's read is in flight
    releaseAll();

    await Promise.all([setP, getP]);
    await expect(store.get<string>('drawio', 'newDiagramFormat')).resolves.toBe('png');
  });

  it('a set is write-through: the next get never re-reads the disk', async () => {
    const files = new Map<string, string>();
    const { io, releaseAll } = deferredIo(files);
    const store = new PluginConfigStore('\\root', io);

    const setP = store.set('drawio', 'format', 'png');
    await settle();
    releaseAll(); // the set's initial cold read
    await setP;

    await expect(store.get<string>('drawio', 'format')).resolves.toBe('png');
    // The tmp file was renamed away — only the config file itself remains.
    expect([...files.keys()].filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('two sets to one plugin serialize; both keys land on disk', async () => {
    const files = new Map<string, string>();
    const { io, releaseAll } = deferredIo(files);
    const store = new PluginConfigStore('\\root', io);

    const first = store.set('tickets', 'vaultId', 'v1');
    const second = store.set('tickets', 'gitPath', 'git');
    await settle();
    releaseAll();
    await Promise.all([first, second]);

    const stored = JSON.parse(files.get('\\root\\tickets\\config.json') ?? '{}') as Record<string, unknown>;
    expect(stored['vaultId']).toBe('v1');
    expect(stored['gitPath']).toBe('git');
  });

  it('a corrupt config never blocks the plugin; the next set heals it', async () => {
    const files = new Map<string, string>([['\\root\\old\\config.json', '{not json']]);
    const { io, releaseAll } = deferredIo(files);
    const store = new PluginConfigStore('\\root', io);

    await expect(store.get<string>('old', 'anything')).resolves.toBeUndefined();
    const setP = store.set('old', 'repaired', true);
    releaseAll();
    await setP;
    const stored = JSON.parse(files.get('\\root\\old\\config.json') ?? '{}') as Record<string, unknown>;
    expect(stored['repaired']).toBe(true);
  });
});
