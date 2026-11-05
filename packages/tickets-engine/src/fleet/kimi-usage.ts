/**
 * The node half of the Kimi adapter's usage seam (E10-8): Kimi's ACP stream
 * carries no token counts, but the CLI writes every model call to the
 * session's wire log — `<home>/sessions/<workspace>/<session>/agents/main/
 * wire.jsonl` — as `usage.record` lines. `<home>` is `KIMI_HOME` when set,
 * else `~/.kimi-code`.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KimiUsageReader, KimiUsageRecord } from './kimi';

/** The records of a wire log's text, in order; lines of other shapes are skipped. */
export function parseKimiWire(raw: string): KimiUsageRecord[] {
  const records: KimiUsageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage.record"')) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { type?: string; model?: string; usage?: Record<string, unknown> };
      if (entry.type !== 'usage.record' || entry.usage === undefined) {
        continue;
      }
      const n = (key: string): number => (typeof entry.usage?.[key] === 'number' ? (entry.usage[key] as number) : 0);
      records.push({
        model: typeof entry.model === 'string' ? entry.model : null,
        inputOther: n('inputOther'),
        output: n('output'),
        cacheRead: n('inputCacheRead'),
        cacheCreation: n('inputCacheCreation'),
      });
    } catch {
      // A half-written last line: the next read picks it up.
    }
  }
  return records;
}

/** Kimi's home folder: the env override, else `~/.kimi-code`. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KIMI_HOME'];
  return override !== undefined && override !== '' ? override : path.join(os.homedir(), '.kimi-code');
}

export function nodeKimiUsageReader(home: string = kimiHome()): KimiUsageReader {
  return async (sessionRef) => {
    // The session id is data from the CLI: never let it climb out of the sessions folder.
    if (!/^[\w-]+$/.test(sessionRef)) {
      return [];
    }
    const root = path.join(home, 'sessions');
    const workspaces = await fsp.readdir(root).catch(() => [] as string[]);
    for (const workspace of workspaces) {
      const wire = path.join(root, workspace, sessionRef, 'agents', 'main', 'wire.jsonl');
      const raw = await fsp.readFile(wire, 'utf8').catch(() => null);
      if (raw !== null) {
        return parseKimiWire(raw);
      }
    }
    return [];
  };
}
