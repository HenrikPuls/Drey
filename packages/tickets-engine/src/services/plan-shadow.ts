/**
 * The plan shadow copies (E10-2, concept v2 §5.8): per shaped ticket the
 * plan as it stood at the end of the model's last turn, plus the lines
 * the model itself changed in that turn. Machine-local state (the engine
 * home), never in the tickets repository: a shadow is a fact about what
 * THIS desk's model has seen, not about the ticket.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export interface PlanShadow {
  /** Counts the model's turns that ended on this ticket's plan; the "v7" of the status line. */
  readonly version: number;
  /** The Plan section at the end of the model's last turn. */
  readonly text: string;
  /** 1-based lines of that text the model changed in its last turn. */
  readonly modelLines: readonly number[];
}

export interface PlanShadowStore {
  get(ticket: string): Promise<PlanShadow | null>;
  set(ticket: string, shadow: PlanShadow): Promise<void>;
}

/** In memory — the specs' store and a desk without a writable home. */
export class MemoryPlanShadowStore implements PlanShadowStore {
  private readonly shadows = new Map<string, PlanShadow>();

  async get(ticket: string): Promise<PlanShadow | null> {
    return this.shadows.get(ticket) ?? null;
  }

  async set(ticket: string, shadow: PlanShadow): Promise<void> {
    this.shadows.set(ticket, shadow);
  }
}

function readShadow(raw: unknown): PlanShadow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['text'] !== 'string' || typeof r['version'] !== 'number' || !Number.isInteger(r['version'])) {
    return null;
  }
  const lines = Array.isArray(r['modelLines']) ? r['modelLines'].filter((n): n is number => Number.isInteger(n)) : [];
  return { version: r['version'], text: r['text'], modelLines: lines };
}

/** One JSON file; writes are queued and atomic (temp file + rename). */
export class FilePlanShadowStore implements PlanShadowStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async get(ticket: string): Promise<PlanShadow | null> {
    await this.queue.catch(() => undefined);
    return readShadow((await this.load())[ticket]);
  }

  set(ticket: string, shadow: PlanShadow): Promise<void> {
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        const all = await this.load();
        all[ticket] = shadow;
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await fsp.writeFile(temp, JSON.stringify(all), 'utf8');
        await fsp.rename(temp, this.file);
      });
    this.queue = run;
    return run;
  }
}
