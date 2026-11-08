import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { NOTES_VAULT_KEY } from '../../../packages/tickets-engine/src/contracts/notes';
import { fleetBuildStamp, isStaleDaemon } from '../../../packages/tickets-engine/src/fleet/build-stamp';
import { WORKER_PROVIDERS } from '../../../packages/tickets-engine/src/fleet/protocol';
import { FileConfigStore } from '../../../packages/tickets-engine/src/server/file-config';
import { SERVICE_ENTRY_NAME, serviceLaunchCommand, spawnService } from '../../../packages/tickets-engine/src/service/launch';
import {
  engineEndpointsOf,
  readServiceLock,
  serviceAlive,
  type ServiceLock,
} from '../../../packages/tickets-engine/src/service/service-lock';
import { STORE_SETTING_KEYS } from '../../../packages/tickets-engine/src/store/store-settings';
import { EngineClient, type EngineEndpoints } from './engine-client';

/**
 * Drey Service from the plugin's side (req-164, ADR-0092): Drey is a client
 * of the service, like the phones. It adopts a running service through
 * `service.lock` in the service home, hands an older build over (the
 * req-51 handover, now for the whole service), or starts one (`launch.ts`,
 * the one spawn path — it replaces the engine's and the fleet runner's).
 * Drey never stops the service: it sleeps on its own once no Drey, no live
 * run, no Autopilot and no paired device holds it (`service/sleep.ts`).
 */

const SERVICE_HOME = (): string => path.join(homedir(), '.drey-engine');
const SERVICE_ENTRY = (): string =>
  path.join(__dirname, '..', '..', '..', 'packages', 'tickets-engine', 'src', 'service', SERVICE_ENTRY_NAME);

/** A live service's lock, or null. */
async function liveLock(home: string): Promise<ServiceLock | null> {
  const lock = await readServiceLock(home);
  return lock !== null && (await serviceAlive(lock)) ? lock : null;
}

/** The engine endpoints of a live service whose engine already answers. */
async function engineOf(lock: ServiceLock): Promise<EngineEndpoints | null> {
  const endpoints = engineEndpointsOf(lock);
  return endpoints !== null && (await new EngineClient(endpoints).health()) ? endpoints : null;
}

/**
 * Asks an older service to hand over and leave (req-51 for the whole
 * service): its runner hands the live runs over, the engine closes, the
 * process exits. A run in its gate refuses (409) — the old service serves
 * on, and the next Drey start asks again.
 */
export async function handOverStaleService(lock: ServiceLock, log: (message: string, level?: 'info' | 'warn' | 'error') => void): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lock.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ handover: true }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      log(`Drey Service (pid ${lock.pid}) predates this build — handover deferred: ${body.error ?? 'busy'}`, 'warn');
      return false;
    }
  } catch {
    // a service that will not take the call: waited out below
  }
  log(`Drey Service (pid ${lock.pid}) predates this build — it hands over to a new one`, 'warn');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await serviceAlive(lock, 500))) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return true;
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

/** The plugin config's keys the engine reads, the ones the plugin config holds. */
async function pluginEntries(ctx: { config: { get<T>(key: string): Promise<T | undefined> } }): Promise<[string, unknown][]> {
  const entries: [string, unknown][] = [];
  for (const key of SYNCED_KEYS(WORKER_PROVIDERS)) {
    const value = await ctx.config.get<unknown>(key);
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return entries;
}

/** The assistant LLM settings as the `chat.*` keys; every key every time, a cleared value is `null`. */
function chatEntries(llm: ChatLlmSettings): [string, unknown][] {
  const text = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());
  return [
    ['chat.enabled', llm.enabled],
    ['chat.provider', text(llm.provider)],
    ['chat.baseUrl', text(llm.baseUrl)],
    ['chat.apiKey', text(llm.apiKey)],
    ['chat.model', text(llm.model)],
  ];
}

/**
 * The same keys {@link syncConfig} pushes, written into the engine's `config.json`
 * BEFORE the service is started (E14-7a). The engine builds its first board while it
 * starts, before anything can reach its invoke channel, and in `shadow` mode that board
 * writes the report: without this the first start after a change of `backend` or
 * `dk.store` described the previous store. Only called with no engine alive, so the
 * file has no other writer; keys the engine owns (its token, paired devices) stay.
 */
export async function mirrorConfig(home: string, ctx: Parameters<typeof syncConfig>[1]): Promise<void> {
  const store = new FileConfigStore(path.join(home, 'config.json'));
  await store.setMany([...(await pluginEntries(ctx)), ...chatEntries(ctx.appConfig.get().llm)]);
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
  for (const [key, value] of await pluginEntries(ctx)) {
    await client.invoke('configSet', { key, value }).catch(() => undefined);
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
  for (const [key, value] of chatEntries(llm)) {
    await client.invoke('configSet', { key, value }).catch(() => undefined);
  }
}

/** The real process start (the one spawn path, `launch.ts`); the spec's seam starts a service in-process instead. */
function startService(vaultPath: string, home: string, log: (message: string) => void): void {
  const pid = spawnService(serviceLaunchCommand({ entry: SERVICE_ENTRY(), home, vaultPath }), home);
  log(`Drey Service started (pid ${pid ?? '?'}) for ${vaultPath}`);
}

/**
 * Adopt a running Drey Service, hand an older build over, or start one;
 * then sync Drey's settings into its engine. Resolves with the engine's
 * invoke endpoints — what the plugin talks to.
 */
export async function ensureService(
  ctx: Parameters<typeof locateTicketsVault>[0] & Parameters<typeof syncConfig>[1],
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
  deps: {
    readonly home?: string;
    readonly spawn?: (vaultPath: string, home: string) => void | Promise<void>;
    /** This build's stamp; the built service entry's by default. */
    readonly ownBuild?: () => Promise<string | null>;
  } = {},
): Promise<EngineEndpoints> {
  const home = deps.home ?? SERVICE_HOME();
  const adopt = async (endpoints: EngineEndpoints): Promise<EngineEndpoints> => {
    await syncConfig(new EngineClient(endpoints), ctx).catch((error: unknown) => log(`engine config sync failed: ${messageOf(error)}`, 'warn'));
    return endpoints;
  };

  const running = await liveLock(home);
  if (running !== null) {
    const own = await (deps.ownBuild ?? (() => fleetBuildStamp(SERVICE_ENTRY())))().catch(() => null);
    const stale = isStaleDaemon(running.build, own);
    if (!stale || !(await handOverStaleService(running, log))) {
      const endpoints = await engineOf(running);
      if (endpoints !== null) {
        return adopt(endpoints);
      }
    }
  }

  const vault = await locateTicketsVault(ctx);
  if (vault === null) {
    throw new Error('no tickets vault detected — Drey Service has nothing to host');
  }
  await fsp.mkdir(home, { recursive: true });
  // A failed mirror costs what it always cost (the adoption's sync below still runs), not the start.
  await mirrorConfig(home, ctx).catch((error: unknown) => log(`engine config mirror failed: ${messageOf(error)}`, 'warn'));
  await (deps.spawn ?? ((vaultPath: string, serviceHome: string) => startService(vaultPath, serviceHome, log)))(vault.path, home);

  // Adopt it through service.lock: health-checked, its engine answering. The
  // first start after an update retires the old engine and runner (up to
  // ~25 s for a runner's handover), so the wait is generous.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const candidate = await liveLock(home);
    const endpoints = candidate === null ? null : await engineOf(candidate);
    if (endpoints !== null) {
      return adopt(endpoints);
    }
    if (Date.now() > deadline) {
      throw new Error(`Drey Service did not come up within 60 s — see ${path.join(home, 'service.log')} and service-start.log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
