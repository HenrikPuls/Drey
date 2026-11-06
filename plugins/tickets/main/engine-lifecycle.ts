import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { NOTES_VAULT_KEY } from '../../../packages/tickets-engine/src/contracts/notes';
import { WORKER_PROVIDERS } from '../../../packages/tickets-engine/src/fleet/protocol';
import { STORE_SETTING_KEYS } from '../../../packages/tickets-engine/src/store/store-settings';
import { EngineClient, type EngineEndpoints } from './engine-client';

/**
 * The engine's lifecycle from the plugin's side (ADR-0088, E2b): adopt a
 * live engine through the lockfile in the engine home, or spawn one
 * (`ELECTRON_RUN_AS_NODE`, the same pattern the fleet runner uses). Drey
 * starts the engine after; it never stops it — the phone may still need
 * it after Drey quits.
 */

const ENGINE_HOME = (): string => path.join(homedir(), '.drey-engine');
const LOCK_FILE = (home: string): string => path.join(home, 'engine.lock');
const ENGINE_ENTRY = (): string =>
  path.join(__dirname, '..', '..', '..', 'packages', 'tickets-engine', 'src', 'server', 'engine-main.js');

interface EngineLock {
  readonly pid: number;
  readonly invokePort: number;
  readonly token: string;
  readonly vaultPath: string;
}

async function readLock(home: string): Promise<EngineLock | null> {
  try {
    return JSON.parse(await fsp.readFile(LOCK_FILE(home), 'utf8')) as EngineLock;
  } catch {
    return null;
  }
}

async function alive(lock: EngineLock): Promise<boolean> {
  const client = new EngineClient({ invokeUrl: `http://127.0.0.1:${lock.invokePort}`, token: lock.token });
  return client.health();
}

/** The tickets vault the engine should host: the detector's probe, plugin-side. */
async function locateTicketsVault(ctx: {
  vault: {
    listVaults(): Promise<readonly { id: string; name: string; path: string; exists: boolean }[]>;
    read(path: string, opts: { vaultId: string }): Promise<string>;
  };
  config: { get<T>(key: string): Promise<T | undefined> };
}): Promise<{ id: string; name: string; path: string } | null> {
  const vaults = (await ctx.vault.listVaults()).filter((v) => v.exists);
  const configured = await ctx.config.get<string>('vaultId');
  const ordered =
    configured === undefined
      ? vaults
      : [...vaults.filter((v) => v.id === configured), ...vaults.filter((v) => v.id !== configured)];
  for (const vault of ordered) {
    try {
      await ctx.vault.read('tickets/_meta/pipeline.md', { vaultId: vault.id });
      return vault;
    } catch {
      // not the tickets vault
    }
  }
  return null;
}

/**
 * Every activation: the Drey config keys the engine reads (fleet caps,
 * pools, handover thresholds, remote settings) flow into the engine's own
 * config store. Most fleet settings apply on restart like they always
 * did; the handover thresholds the board re-reads live take effect on
 * the next snapshot.
 */
const SYNCED_KEYS = (providers: readonly string[]): readonly string[] => [
  'gitPath',
  'defaultWorker',
  'personas.humanName',
  'autoPermissionMode',
  'vaultId',
  ...STORE_SETTING_KEYS,
  ...['gateFailureLines', 'gateFailureBytes', 'diffStatLines', 'diffStatBytes'].map((k) => `fleet.cap.${k}`),
  ...providers.flatMap((p) => [`fleet.pool.${p}.size`, `fleet.pool.${p}.probe`]),
  'fleet.compactAboveTokens',
  'fleet.resumePauseTtlMin',
  'fleet.contextCapTokens',
  ...providers.flatMap((p) => [
    `fleet.compactAboveTokens.${p}`,
    `fleet.contextCapTokens.${p}`,
  ]),
  'remote.enabled',
  'remote.mode',
  'remote.lanAddress',
  'remote.port',
  'remote.publicUrl',
  'remote.allowBypass',
  'remote.devices',
];

/** The assistant LLM slice the chat bridge needs, out of the base app config. */
interface ChatLlmSettings {
  readonly enabled: boolean;
  /** Drey's provider id (ADR-0047) -- the engine picks the wire dialect from it, or refuses the provider by name. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string | null;
}

/** The narrow invoke surface the sync needs — EngineClient fits it. */
interface ConfigSyncClient {
  invoke(method: string, payload?: unknown): Promise<unknown>;
}

/**
 * Pushes the synced keys into the engine's config store. The assistant
 * LLM settings (the app config's llm slice, ADR-0047) ride along mapped
 * onto the chat.* keys the Mission Control bridge reads — so
 * activation/adoption always hands the engine the provider the assistant
 * already uses. The api key travels the invoke channel but is never
 * logged; keys the settings do not carry are left untouched.
 */
export async function syncConfig(client: ConfigSyncClient, ctx: {
  config: { get<T>(key: string): Promise<T | undefined> };
  appConfig: { get(): { llm: ChatLlmSettings } };
}): Promise<void> {
  for (const key of SYNCED_KEYS(WORKER_PROVIDERS)) {
    const value = await ctx.config.get<unknown>(key);
    if (value !== undefined) {
      await client.invoke('configSet', { key, value }).catch(() => undefined);
    }
  }
  await syncChatConfig(client, ctx.appConfig.get().llm);
}

/**
 * The ticket store's keys (`backend`, `dk.*`) alone, pushed whenever the board is
 * fetched: Settings -> Tickets writes them to the plugin config, the engine reads its
 * own, and a changed checkout or sync interval must apply without a restart (E14-4c).
 * Only keys the plugin config holds travel (a cleared field arrives as an empty value).
 */
export async function syncStoreConfig(client: ConfigSyncClient, ctx: { config: { get<T>(key: string): Promise<T | undefined> } }): Promise<void> {
  for (const key of STORE_SETTING_KEYS) {
    const value = await ctx.config.get<unknown>(key);
    if (value !== undefined) {
      await client.invoke('configSet', { key, value }).catch(() => undefined);
    }
  }
}

/**
 * Tells the engine which vault its Notes API serves (req-100): Drey's active
 * vault. The engine outlives Drey and keeps the last one named, so a phone
 * still reaches the notes with Drey closed. No active vault changes nothing.
 */
export async function syncNotesVault(
  client: ConfigSyncClient,
  ctx: { vault: { listVaults(): Promise<readonly { path: string; exists: boolean; active: boolean }[]> } },
): Promise<void> {
  const active = (await ctx.vault.listVaults()).find((vault) => vault.active && vault.exists);
  if (active !== undefined) {
    await client.invoke('configSet', { key: NOTES_VAULT_KEY, value: active.path });
  }
}

/**
 * Pushes the assistant LLM settings into the engine as the `chat.*` keys
 * the Mission Control bridge reads. Every key travels every time -- a
 * cleared model or key arrives as `null` instead of leaving the old value
 * behind (D-1: a stale endpoint was the failure). Runs at activation and
 * adoption (`syncConfig`) and again on every change of the app config
 * (`appConfig.onChange`, SDK 1.40), so Settings -> Assistant applies to the
 * next chat turn without a restart. The api key travels the invoke
 * channel and is never logged.
 */
export async function syncChatConfig(client: ConfigSyncClient, llm: ChatLlmSettings): Promise<void> {
  const text = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());
  const chatKeys: [string, unknown][] = [
    ['chat.enabled', llm.enabled],
    ['chat.provider', text(llm.provider)],
    ['chat.baseUrl', text(llm.baseUrl)],
    ['chat.apiKey', text(llm.apiKey)],
    ['chat.model', text(llm.model)],
  ];
  for (const [key, value] of chatKeys) {
    await client.invoke('configSet', { key, value }).catch(() => undefined);
  }
}

export async function ensureEngine(
  ctx: Parameters<typeof locateTicketsVault>[0] & Parameters<typeof syncConfig>[1],
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<EngineEndpoints> {
  const home = ENGINE_HOME();
  const lock = await readLock(home);
  if (lock !== null && (await alive(lock))) {
    const endpoints = { invokeUrl: `http://127.0.0.1:${lock.invokePort}`, token: lock.token };
    const client = new EngineClient(endpoints);
    await syncConfig(client, ctx).catch((error: unknown) => log(`engine config sync failed: ${messageOf(error)}`, 'warn'));
    return endpoints;
  }

  const vault = await locateTicketsVault(ctx);
  if (vault === null) {
    throw new Error('no tickets vault detected — the engine has nothing to host');
  }
  await fsp.mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [ENGINE_ENTRY(), '--vault', vault.path, '--home', home], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  log(`tickets engine spawned (pid ${child.pid ?? '?'}) for ${vault.path}`);

  // Adopt it through the lockfile: health-checked, up to 20 s.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const candidate = await readLock(home);
    if (candidate !== null && (await alive(candidate))) {
      const endpoints = { invokeUrl: `http://127.0.0.1:${candidate.invokePort}`, token: candidate.token };
      const client = new EngineClient(endpoints);
      await syncConfig(client, ctx).catch((error: unknown) => log(`engine config sync failed: ${messageOf(error)}`, 'warn'));
      return endpoints;
    }
    if (Date.now() > deadline) {
      throw new Error('the tickets engine did not come up within 20 s — see the engine home log');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
