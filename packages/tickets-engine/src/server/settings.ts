/**
 * The Mission Control settings the engine owns (E12-3, ADR-0088 later
 * change): the per-vault half of the settings screen — the paired devices
 * and the engine keys. Appearance never reaches the engine; it is per
 * device and lives in the app's local storage.
 *
 * Engine keys (the engine config store, `~/.drey-engine/config.json`):
 * `videos.inGit` (default false) and `videos.maxMb` (default 25, the cap
 * of ONE video; E11-1c — nothing is ever deleted automatically) — what
 * they govern is specified in `specs/ticket-schema.md`, "Videos". The
 * retired `videos.limitMb` (a folder total) is ignored and dropped by
 * `VideoService.prepare`.
 */
import type { Parsed } from '../core/commands';
import { CHAT_KEYS, providerLabelOf, resolveChatModel, type ChatModelConfig } from '../services/chat-model';
import type { DeviceView } from './auth';

export const SETTINGS_KEYS = {
  videosInGit: 'videos.inGit',
  videosMaxMb: 'videos.maxMb',
  /** Retired by E11-1c; only read to be removed. */
  videosLimitMbRetired: 'videos.limitMb',
} as const;

export const DEFAULT_VIDEO_MAX_MB = 25;
export const MIN_VIDEO_MAX_MB = 1;
export const MAX_VIDEO_MAX_MB = 200;

export interface VideoSettings {
  readonly inGit: boolean;
  /** The cap of one video in MB; a longer recording is not kept. */
  readonly maxMb: number;
  /** Videos currently in `tickets/videos/` (the "Include the n existing videos" count). */
  readonly existing: number;
}

/**
 * The chat model as the settings screen shows it (D-1, E12-3b): what
 * Drey pushed (`chat.*` keys) — never the API key itself, only whether
 * one is set. `problem` is why a turn would have no model right now.
 */
export interface ChatSettings {
  readonly provider: string;
  readonly providerLabel: string;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly hasKey: boolean;
  /** null = a turn can run; otherwise the reason in one sentence (the same text the chat's error card shows). */
  readonly problem: string | null;
}

export interface EngineSettings {
  readonly videos: VideoSettings;
  readonly chat: ChatSettings;
}

/** One paired device as the settings screen lists it; `current` marks the asker. */
export interface SettingsDevice extends DeviceView {
  readonly current: boolean;
}

export interface SettingsReply {
  readonly ok: true;
  readonly devices: readonly SettingsDevice[];
  readonly engine: EngineSettings;
}

export interface SettingsPatch {
  readonly inGit?: boolean;
  readonly maxMb?: number;
  /** Turning `inGit` on is a confirmed act (the warning dialog); the flag carries the confirmation. */
  readonly confirm?: boolean;
  /** With the confirmation: also commit the videos already in the folder ("Include the n existing videos"). */
  readonly includeExisting?: boolean;
}

/** The outcome of the Chat row's "Test connection". */
export interface ChatTestReply {
  readonly ok: boolean;
  readonly message: string;
}

/** The engine side the router calls; the remote service implements it over its config store. */
export interface SettingsAccess {
  /** Probes the configured chat endpoint (a cheap model-list GET); never throws. */
  testChat(): Promise<ChatTestReply>;
  read(askingDevice: string): Promise<SettingsReply>;
  patch(patch: SettingsPatch, askingDevice: string): Promise<{ ok: false; error: string } | SettingsReply>;
  revoke(id: string, askingDevice: string): Promise<{ ok: false; error: string } | SettingsReply>;
}

/** Folds stored values into valid settings; anything odd is the default. */
export function isVideoMaxMb(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_VIDEO_MAX_MB && value <= MAX_VIDEO_MAX_MB;
}

export function normalizeVideoSettings(raw: { inGit?: unknown; maxMb?: unknown }, existing: number): VideoSettings {
  return {
    inGit: raw.inGit === true,
    maxMb: isVideoMaxMb(raw.maxMb) ? raw.maxMb : DEFAULT_VIDEO_MAX_MB,
    existing,
  };
}

/** The Chat row's content: what Drey pushed and whether a turn could run on it. */
export async function chatSettingsOf(config: ChatModelConfig): Promise<ChatSettings> {
  const resolved = await resolveChatModel(config);
  const [provider, baseUrl, model, key] = await Promise.all([
    config.get<string>(CHAT_KEYS.provider),
    config.get<string>(CHAT_KEYS.baseUrl),
    config.get<string>(CHAT_KEYS.model),
    config.get<string>(CHAT_KEYS.apiKey),
  ]);
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const id = resolved.ok ? resolved.spec.provider : resolved.failure.provider;
  return {
    provider: id,
    providerLabel: providerLabelOf(id),
    baseUrl: text(baseUrl),
    model: text(model),
    hasKey: text(key) !== null,
    problem: resolved.ok ? null : resolved.failure.message,
  };
}

export function parseSettingsPatch(body: unknown): Parsed<SettingsPatch> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'bad settings payload' };
  }
  const obj = body as Record<string, unknown>;
  const { inGit, maxMb, confirm, includeExisting } = obj;
  if (inGit !== undefined && typeof inGit !== 'boolean') {
    return { ok: false, error: 'inGit is true or false' };
  }
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return { ok: false, error: 'confirm is true or false' };
  }
  if (includeExisting !== undefined && typeof includeExisting !== 'boolean') {
    return { ok: false, error: 'includeExisting is true or false' };
  }
  if (maxMb !== undefined && !isVideoMaxMb(maxMb)) {
    return { ok: false, error: `the largest video is a whole number of MB from ${MIN_VIDEO_MAX_MB} to ${MAX_VIDEO_MAX_MB}` };
  }
  if (inGit === undefined && maxMb === undefined) {
    return { ok: false, error: 'nothing to change' };
  }
  return { ok: true, value: { inGit, maxMb, confirm, includeExisting } };
}

export function parseRevoke(body: unknown): Parsed<{ id: string }> {
  const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? { ok: true, value: { id } }
    : { ok: false, error: 'a revoke needs a device id' };
}
