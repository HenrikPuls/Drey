import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { WORKER_PROVIDERS } from '../../../packages/tickets-engine/src/fleet/protocol';
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
  'autoPermissionMode',
  'vaultId',
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
  const llm = ctx.appConfig.get().llm;
  const chatKeys: [string, string | null][] = [
    ['chat.baseUrl', llm.baseUrl.trim() === '' ? null : llm.baseUrl.trim()],
    ['chat.apiKey', llm.apiKey === null || llm.apiKey.trim() === '' ? null : llm.apiKey.trim()],
    ['chat.model', llm.model === null || llm.model.trim() === '' ? null : llm.model.trim()],
  ];
  for (const [key, value] of chatKeys) {
    if (value !== null) {
      await client.invoke('configSet', { key, value }).catch(() => undefined);
    }
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
