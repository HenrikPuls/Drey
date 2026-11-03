/**
 * The Mission Control settings the engine owns (E12-3, ADR-0088 later
 * change): the per-vault half of the settings screen — the paired devices
 * and the engine keys. Appearance never reaches the engine; it is per
 * device and lives in the app's local storage.
 *
 * Engine keys (the engine config store, `~/.drey-engine/config.json`):
 * `videos.inGit` (default false) and `videos.limitMb` (default 2000) —
 * what they govern is specified in `specs/ticket-schema.md`, "Videos".
 */
import type { Parsed } from '../core/commands';
import type { DeviceView } from './auth';

export const SETTINGS_KEYS = {
  videosInGit: 'videos.inGit',
  videosLimitMb: 'videos.limitMb',
} as const;

export const DEFAULT_VIDEO_LIMIT_MB = 2000;
export const MIN_VIDEO_LIMIT_MB = 100;
export const MAX_VIDEO_LIMIT_MB = 100_000;

export interface VideoSettings {
  readonly inGit: boolean;
  readonly limitMb: number;
  /** Videos currently in `tickets/videos/` (the "Include the n existing videos" count). */
  readonly existing: number;
  /** A standing notice the screen shows under the limit (E11-1); null = none. */
  readonly notice: string | null;
}

export interface EngineSettings {
  readonly videos: VideoSettings;
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
  readonly limitMb?: number;
  /** Turning `inGit` on is a confirmed act (the warning dialog); the flag carries the confirmation. */
  readonly confirm?: boolean;
  /** With the confirmation: also commit the videos already in the folder ("Include the n existing videos"). */
  readonly includeExisting?: boolean;
}

/** The engine side the router calls; the remote service implements it over its config store. */
export interface SettingsAccess {
  read(askingDevice: string): Promise<SettingsReply>;
  patch(patch: SettingsPatch, askingDevice: string): Promise<{ ok: false; error: string } | SettingsReply>;
  revoke(id: string, askingDevice: string): Promise<{ ok: false; error: string } | SettingsReply>;
}

/** Folds stored values into valid settings; anything odd is the default. */
export function normalizeVideoSettings(
  raw: { inGit?: unknown; limitMb?: unknown },
  existing: number,
  notice: string | null = null,
): VideoSettings {
  const limit = raw.limitMb;
  return {
    inGit: raw.inGit === true,
    limitMb:
      typeof limit === 'number' && Number.isInteger(limit) && limit >= MIN_VIDEO_LIMIT_MB && limit <= MAX_VIDEO_LIMIT_MB
        ? limit
        : DEFAULT_VIDEO_LIMIT_MB,
    existing,
    notice,
  };
}

export function parseSettingsPatch(body: unknown): Parsed<SettingsPatch> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'bad settings payload' };
  }
  const obj = body as Record<string, unknown>;
  const { inGit, limitMb, confirm, includeExisting } = obj;
  if (inGit !== undefined && typeof inGit !== 'boolean') {
    return { ok: false, error: 'inGit is true or false' };
  }
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return { ok: false, error: 'confirm is true or false' };
  }
  if (includeExisting !== undefined && typeof includeExisting !== 'boolean') {
    return { ok: false, error: 'includeExisting is true or false' };
  }
  if (
    limitMb !== undefined &&
    !(typeof limitMb === 'number' && Number.isInteger(limitMb) && limitMb >= MIN_VIDEO_LIMIT_MB && limitMb <= MAX_VIDEO_LIMIT_MB)
  ) {
    return { ok: false, error: `the video limit is a whole number of MB from ${MIN_VIDEO_LIMIT_MB} to ${MAX_VIDEO_LIMIT_MB}` };
  }
  if (inGit === undefined && limitMb === undefined) {
    return { ok: false, error: 'nothing to change' };
  }
  return { ok: true, value: { inGit, limitMb, confirm, includeExisting } };
}

export function parseRevoke(body: unknown): Parsed<{ id: string }> {
  const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? { ok: true, value: { id } }
    : { ok: false, error: 'a revoke needs a device id' };
}
