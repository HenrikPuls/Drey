/**
 * Per-plugin config: `<userData>/plugins/<id>/config.json`, one flat JSON
 * object of keys the plugin set through `ctx.config` / `api.settings`.
 *
 * Built-in plugins get their config here too — their code folder may live
 * inside the asar (read-only), and plugin config is app data (ADR-0010),
 * not vault content. Writes are atomic (tmp + rename) so a crash mid-write
 * cannot truncate the file; reads are cached (write-through) so the get
 * path never touches disk after the first call.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLUGIN_ID_PATTERN } from '../../shared/plugin-api';

/** The disk ops the store needs — a seam so specs can defer and inspect. */
export interface ConfigIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const nodeIo: ConfigIo = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, text) => fs.promises.writeFile(file, text, 'utf8'),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
  rename: (from, to) => fs.promises.rename(from, to),
};

export class PluginConfigStore {
  private readonly cache = new Map<string, Record<string, unknown>>();
  /** Serializes a plugin's read-modify-write rounds (one promise tail per id). */
  private readonly rounds = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pluginsRoot: string,
    private readonly io: ConfigIo = nodeIo,
  ) {}

  async get<T>(pluginId: string, key: string): Promise<T | undefined> {
    const config = await this.readAll(pluginId);
    return config[key] as T | undefined;
  }

  async set<T>(pluginId: string, key: string, value: T): Promise<void> {
    assertPluginId(pluginId);
    return this.enqueue(pluginId, async () => {
      // Copy — the cached object must never be mutated in place, or a
      // concurrent read observes a half-applied round. The base comes
      // from the cache or straight from disk — never from `readAll`,
      // whose round would queue behind THIS one (a deadlock).
      const raced = this.cache.get(pluginId);
      const config = { ...(raced ?? (await this.readFromDisk(pluginId))), [key]: value };
      this.cache.set(pluginId, config); // write-through: the next get never waits for the disk
      const file = this.fileFor(pluginId);
      await this.io.mkdir(path.dirname(file));
      const tmp = `${file}.tmp`;
      await this.io.writeFile(tmp, JSON.stringify(config, null, 2));
      await this.io.rename(tmp, file);
    });
  }

  /** Reads (and caches) the whole config object; missing/corrupt file -> `{}`. */
  private async readAll(pluginId: string): Promise<Record<string, unknown>> {
    assertPluginId(pluginId);
    const cached = this.cache.get(pluginId);
    if (cached !== undefined) {
      return cached;
    }
    return this.enqueue(pluginId, async () => {
      // A concurrent set() may have cached a newer config while this
      // read was pending — the cache wins over the stale disk state.
      const raced = this.cache.get(pluginId);
      if (raced !== undefined) {
        return raced;
      }
      const config = await this.readFromDisk(pluginId);
      this.cache.set(pluginId, config);
      return config;
    });
  }

  /** One disk read, no cache and no queue — the caller decides both. */
  private async readFromDisk(pluginId: string): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.io.readFile(this.fileFor(pluginId)));
    } catch {
      return {}; // Missing or corrupt — a corrupt config never blocks the plugin.
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  /** One promise tail per plugin id: rounds never interleave, the tail self-cleans. */
  private enqueue<T>(pluginId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.rounds.get(pluginId) ?? Promise.resolve();
    const result = previous.then(op);
    const settled = result.catch(() => undefined);
    this.rounds.set(pluginId, settled);
    void settled.then(() => {
      if (this.rounds.get(pluginId) === settled) {
        this.rounds.delete(pluginId);
      }
    });
    return result;
  }

  private fileFor(pluginId: string): string {
    return path.join(this.pluginsRoot, pluginId, 'config.json');
  }
}

function assertPluginId(pluginId: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`invalid plugin id "${pluginId}"`);
  }
}
