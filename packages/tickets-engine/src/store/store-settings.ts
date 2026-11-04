import { parseTicketBackend, type TicketBackend, type TicketRecord } from '../ports/ticket-store';
import { DkProcess } from './dk-process';
import { DricketTicketStore } from './dricket-ticket-store';

/**
 * The settings behind `tickets.backend` (E14-1) and the factory that turns
 * them into a store. Keys are the tickets plugin's own (`backend`, `dk.path`,
 * `dk.store`, `dk.dataDir`); `files` stays the default until the cut-over
 * (E14-7), so a missing or unknown value never reaches dricket.
 */
export interface StoreSettings {
  /** What the UI shows. `shadow` is `files` here, with {@link shadow} set. */
  readonly backend: TicketBackend;
  /**
   * `tickets.backend: shadow` (E14-2): the UI keeps showing the files board while
   * the board is also built from the dricket store and compared; the diff report
   * lands beside the engine's data (`<userRoot>/shadow/`). Never changes what is shown.
   */
  readonly shadow: boolean;
  /** `dk` executable; empty = `dk` on PATH. */
  readonly dkPath: string;
  /** The dricket store (directory or `<remote>#<branch>`); empty = not configured. */
  readonly dkStore: string;
  /** Private working copies (`DK_DATA_DIR`); empty = dk's default. */
  readonly dkDataDir: string;
}

export const STORE_SETTING_KEYS = ['backend', 'dk.path', 'dk.store', 'dk.dataDir'] as const;

export async function readStoreSettings(configGet: <T>(key: string) => Promise<T | undefined>): Promise<StoreSettings> {
  const text = async (key: string): Promise<string> => ((await configGet<string>(key)) ?? '').trim();
  return {
    backend: parseTicketBackend(await configGet<string>('backend')),
    shadow: (await configGet<string>('backend')) === 'shadow',
    dkPath: await text('dk.path'),
    dkStore: await text('dk.store'),
    dkDataDir: await text('dk.dataDir'),
  };
}

export function createDricketStore(settings: StoreSettings, env?: NodeJS.ProcessEnv): DricketTicketStore {
  return new DricketTicketStore(
    new DkProcess({
      bin: settings.dkPath === '' ? 'dk' : settings.dkPath,
      store: settings.dkStore,
      dataDir: settings.dkDataDir === '' ? null : settings.dkDataDir,
      // dk v0.6.0: parallel reads of one store collide on its private working copy
      // (git exit 128, dricket requirement R-26) - reads go one at a time until that is fixed.
      readConcurrency: 1,
      ...(env === undefined ? {} : { env }),
    }),
  );
}

// ---------------------------------------------------------------------------
// The read-only board listing

export interface StoreColumn {
  readonly stage: string;
  readonly tickets: readonly TicketRecord[];
}

export type StoreListing =
  | { readonly ok: true; readonly backend: TicketBackend; readonly version: string | null; readonly columns: readonly StoreColumn[] }
  | { readonly ok: false; readonly backend: TicketBackend; readonly error: string };

/** Known stages first in the order a ticket travels, the rest alphabetically. Display only — no stage logic. */
const STAGE_ORDER = ['open', 'inbox', 'prioritized', 'in-progress', 'build', 'review', 'commit', 'blocked', 'done', 'cancelled'];

export function groupByStage(records: readonly TicketRecord[]): StoreColumn[] {
  const byStage = new Map<string, TicketRecord[]>();
  for (const record of records) {
    const list = byStage.get(record.stage) ?? [];
    list.push(record);
    byStage.set(record.stage, list);
  }
  const rank = (stage: string): number => {
    const i = STAGE_ORDER.indexOf(stage);
    return i < 0 ? STAGE_ORDER.length : i;
  };
  return [...byStage.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([stage, tickets]) => ({ stage, tickets: [...tickets].sort((x, y) => x.id.localeCompare(y.id)) }));
}
