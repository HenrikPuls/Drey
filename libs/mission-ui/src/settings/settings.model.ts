import { InjectionToken, type Signal } from '@angular/core';

/** One paired device as the settings screen lists it. */
export interface McSettingsDevice {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly pairedAt: string;
  readonly lastSeen: string | null;
  /** The device asking — it cannot revoke itself. */
  readonly current: boolean;
}

/** The per-vault settings the desk sends (`GET /api/settings`). */
export interface McSettingsView {
  readonly devices: readonly McSettingsDevice[];
  readonly videos: {
    readonly inGit: boolean;
    readonly limitMb: number;
    /** Videos in `tickets/videos/` — the "Include the n existing videos" count. */
    readonly existing: number;
    /** A standing notice from the engine (the limit cannot free space); null = none. */
    readonly notice: string | null;
  };
}

export type McSettingsReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Reads the desk's settings answer tolerantly; null = not a settings answer. */
export function parseSettings(json: unknown): McSettingsView | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const body = json as Record<string, unknown>;
  const engine = body['engine'] as Record<string, unknown> | undefined;
  const videos = engine?.['videos'] as Record<string, unknown> | undefined;
  if (body['ok'] !== true || videos === undefined) {
    return null;
  }
  const devices = Array.isArray(body['devices']) ? body['devices'] : [];
  return {
    devices: devices.flatMap((raw): McSettingsDevice[] => {
      const d = raw as Record<string, unknown> | null;
      if (d === null || typeof d !== 'object' || typeof d['id'] !== 'string' || typeof d['name'] !== 'string') {
        return [];
      }
      return [
        {
          id: d['id'],
          name: d['name'],
          readOnly: d['readOnly'] === true,
          pairedAt: typeof d['pairedAt'] === 'string' ? d['pairedAt'] : '',
          lastSeen: typeof d['lastSeen'] === 'string' ? d['lastSeen'] : null,
          current: d['current'] === true,
        },
      ];
    }),
    videos: {
      inGit: videos['inGit'] === true,
      limitMb: typeof videos['limitMb'] === 'number' ? videos['limitMb'] : 2000,
      existing: typeof videos['existing'] === 'number' ? videos['existing'] : 0,
      notice: typeof videos['notice'] === 'string' ? videos['notice'] : null,
    },
  };
}

/** What the settings screen consumes of the app state (the per-vault half). */
export interface McSettingsState {
  readonly settings: Signal<McSettingsView | null>;
  /** Why the load failed; null when all is well. */
  readonly settingsError: Signal<string | null>;
  load(): Promise<void>;
  setVideoLimit(limitMb: number): Promise<McSettingsReply>;
  /** Turning it on carries `confirm: true` (the warning dialog's yes). */
  setVideosInGit(inGit: boolean, confirm: boolean, includeExisting?: boolean): Promise<McSettingsReply>;
  revokeDevice(id: string): Promise<McSettingsReply>;
}

export const MC_SETTINGS_STATE = new InjectionToken<McSettingsState>('mc.settings-state');
