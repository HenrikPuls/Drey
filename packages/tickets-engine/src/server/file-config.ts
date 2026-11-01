import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * The standalone engine's config store (ADR-0088, E2b): a JSON file in the
 * engine home (`~/.drey-engine/config.json`). Same key/value shape the
 * Drey plugin context exposes (`config.get`/`config.set`), so the remote
 * service and the handover readers run unchanged on both hosts. Atomic
 * write (temp + rename); a torn read falls back to {}.
 */
export class FileConfigStore {
  private cache: Record<string, unknown> | null = null;

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, unknown>> {
    if (this.cache !== null) {
      return this.cache;
    }
    try {
      this.cache = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const data = await this.load();
    return data[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const data = await this.load();
    data[key] = value;
    this.cache = data;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }
}
