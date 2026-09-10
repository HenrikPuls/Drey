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

export class PluginConfigStore {
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly pluginsRoot: string) {}

  async get<T>(pluginId: string, key: string): Promise<T | undefined> {
    const config = await this.readAll(pluginId);
    return config[key] as T | undefined;
  }

  async set<T>(pluginId: string, key: string, value: T): Promise<void> {
    assertPluginId(pluginId);
    const config = await this.readAll(pluginId);
    config[key] = value;
    await this.writeAll(pluginId, config);
    this.cache.set(pluginId, config);
  }

  /** Reads (and caches) the whole config object; missing/corrupt file -> `{}`. */
  private async readAll(pluginId: string): Promise<Record<string, unknown>> {
    assertPluginId(pluginId);
    const cached = this.cache.get(pluginId);
    if (cached !== undefined) {
      return cached;
    }
    const file = this.fileFor(pluginId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      const empty: Record<string, unknown> = {};
      this.cache.set(pluginId, empty);
      return empty; // Missing or corrupt — a corrupt config never blocks the plugin.
    }
    const config =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    this.cache.set(pluginId, config);
    return config;
  }

  private async writeAll(pluginId: string, config: Record<string, unknown>): Promise<void> {
    const file = this.fileFor(pluginId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
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
