import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventWriter, SCAN_CACHE_MS, statusLogPathOf, statusPathFor } from './event-writer';
import { LEDGER_FILE, parseLedger } from '../core/ledger';
import { parseStatusLog } from '../core/status-log';

/**
 * The runner's E7 event writer against a real temp vault: the promise
 * mutex serializes a burst of writes, the ledger and status-log files
 * start on first use, the .md → .status.log swap is exact, and a failure
 * (a blocked path reads like EBUSY on Windows) logs and swallows — the
 * writer never throws into the orchestration loop.
 */

let vaultDir = '';
let logs: string[];

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await cond()).toBe(true);
}

beforeEach(async () => {
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-events-'));
  logs = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(vaultDir, { recursive: true, force: true });
});

function writer(): FleetEventWriter {
  return new FleetEventWriter({ vaultPath: vaultDir, log: (message) => logs.push(message) });
}

describe('FleetEventWriter', () => {
  it('serializes a burst of writes: ledger lines keep call order through the mutex', async () => {
    const events = writer();
    events.ledger({ kind: 'dispatched', ticket: 'T-0001', persona: 'pia', model: 'opus' });
    events.status('tickets/plan/T-0001.md', '2026-11-02T09:00:00Z', 'working', 'plan on opus');
    events.ledger({ kind: 'phase', ticket: 'T-0001', from: 'plan', to: 'review' });

    const ledgerPath = path.join(vaultDir, LEDGER_FILE);
    let ledgerText = '';
    await waitFor(async () => {
      ledgerText = await fsp.readFile(ledgerPath, 'utf8').catch(() => '');
      return parseLedger(ledgerText).length === 2;
    });
    expect(parseLedger(ledgerText).map((event) => event.kind)).toEqual(['dispatched', 'phase']);
    // The status write of the same burst went to the ticket's log, in between.
    const statusPath = path.join(vaultDir, 'tickets', 'plan', 'T-0001.status.log');
    await waitFor(async () => (await fsp.readFile(statusPath, 'utf8').catch(() => '')) !== '');
  });

  it('starts the ledger file with the first line and repairs a torn tail', async () => {
    const metaDir = path.join(vaultDir, 'tickets', '_meta');
    await fsp.mkdir(metaDir, { recursive: true });
    // A torn write: no trailing newline — the next line must not glue onto it.
    await fsp.writeFile(path.join(metaDir, 'ledger.jsonl'), '{"v":1,"ts":"t","event":"archived","ticket":"T-0000"}', 'utf8');

    const events = writer();
    events.ledger({ kind: 'dispatched', ticket: 'T-0001' });
    const ledgerPath = path.join(vaultDir, LEDGER_FILE);
    await waitFor(async () => ((await fsp.readFile(ledgerPath, 'utf8').catch(() => '')).match(/\n/g) ?? []).length >= 2);
    const text = await fsp.readFile(ledgerPath, 'utf8');
    const eventsRead = parseLedger(text);
    expect(eventsRead.map((event) => event.ticket)).toEqual(['T-0000', 'T-0001']);
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(text.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2);
  });

  it('appends the status line to the .status.log beside the card, creating it', async () => {
    const events = writer();
    expect(statusLogPathOf('tickets/plan/T-0001.md')).toBe('tickets/plan/T-0001.status.log');
    expect(statusLogPathOf('tickets/plan/T-0001.status.log')).toBe('tickets/plan/T-0001.status.log');

    events.status('tickets/plan/T-0001.md', '2026-11-02T09:00:00Z', 'working', 'plan on opus');
    const logPath = path.join(vaultDir, 'tickets', 'plan', 'T-0001.status.log');
    await waitFor(async () => (await fsp.readFile(logPath, 'utf8').catch(() => '')) !== '');
    const lines = parseStatusLog(await fsp.readFile(logPath, 'utf8'));
    expect(lines).toEqual([{ at: '2026-11-02T09:00:00Z', verb: 'working', key: null, text: 'plan on opus' }]);

    // The next line appends, not overwrites.
    events.status('tickets/plan/T-0001.md', '2026-11-02T09:45:00Z', 'done', 'handed over on plan');
    await waitFor(async () => parseStatusLog(await fsp.readFile(logPath, 'utf8').catch(() => '')).length === 2);
  });

  it('swallows and logs a blocked write (EBUSY-shaped), never throws, and keeps writing', async () => {
    // `tickets` as a FILE: every mkdir/read beneath fails ENOTDIR —
    // the Windows-flavoured cousin of EBUSY on a locked file.
    await fsp.writeFile(path.join(vaultDir, 'tickets'), 'blocked', 'utf8');
    const events = writer();
    expect(() => events.ledger({ kind: 'dispatched', ticket: 'T-0001' })).not.toThrow();
    expect(() => events.status('tickets/plan/T-0001.md', '2026-11-02T09:00:00Z', 'working', 'plan on opus')).not.toThrow();
    await waitFor(() => logs.length >= 2);
    expect(logs.every((line) => line.startsWith('event writer:') && line.includes('failed'))).toBe(true);

    // The mutex recovered: with the path usable again the next write lands.
    await fsp.rm(path.join(vaultDir, 'tickets'));
    events.ledger({ kind: 'dispatched', ticket: 'T-0002' });
    const ledgerPath = path.join(vaultDir, LEDGER_FILE);
    await waitFor(async () => parseLedger(await fsp.readFile(ledgerPath, 'utf8').catch(() => '')).length === 1);
  });
});

describe('statusPathFor', () => {
  it('finds the card in numbered and plain phase dirs, skipping _meta and archive', async () => {
    await fsp.mkdir(path.join(vaultDir, 'tickets', '20-build'), { recursive: true });
    await fsp.mkdir(path.join(vaultDir, 'tickets', 'inbox'), { recursive: true });
    await fsp.mkdir(path.join(vaultDir, 'tickets', '_meta'), { recursive: true });
    await fsp.mkdir(path.join(vaultDir, 'tickets', 'archive'), { recursive: true });
    await fsp.writeFile(path.join(vaultDir, 'tickets', '20-build', 'T-0001.md'), '# t', 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', 'inbox', 'T-0002.md'), '# t', 'utf8');
    await fsp.writeFile(path.join(vaultDir, 'tickets', 'archive', 'T-0003.md'), '# t', 'utf8');

    await expect(statusPathFor(vaultDir, 'T-0001')).resolves.toBe('tickets/20-build/T-0001.md');
    await expect(statusPathFor(vaultDir, 'T-0002')).resolves.toBe('tickets/inbox/T-0002.md');
    await expect(statusPathFor(vaultDir, 'T-0003')).resolves.toBeNull(); // archive holds no board card
    await expect(statusPathFor(vaultDir, 'T-0099')).resolves.toBeNull();
  });

  it('caches the scan for 5 s: a deleted card still resolves until the cache expires', async () => {
    const dir = path.join(vaultDir, 'tickets', 'plan');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'T-0001.md'), '# t', 'utf8');

    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(statusPathFor(vaultDir, 'T-0001')).resolves.toBe('tickets/plan/T-0001.md');
    await fsp.rm(path.join(dir, 'T-0001.md'));
    // Within the window the cached answer stands…
    await expect(statusPathFor(vaultDir, 'T-0001')).resolves.toBe('tickets/plan/T-0001.md');
    // …past it the dirs re-scan.
    now += SCAN_CACHE_MS + 1;
    await expect(statusPathFor(vaultDir, 'T-0001')).resolves.toBeNull();
  });
});
