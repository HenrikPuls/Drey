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

/** The chat model as Drey pushed it (D-1, E12-3b): read-only here, never the key itself. */
export interface McChatSettings {
  readonly providerLabel: string;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly hasKey: boolean;
  /** Why a chat turn could not run right now (the error card's text); null = it can. */
  readonly problem: string | null;
}

/** The outcome of "Test connection". */
export interface McChatTest {
  readonly ok: boolean;
  readonly message: string;
}

/** The per-vault settings the desk sends (`GET /api/settings`). */
export interface McSettingsView {
  /** The Chat row; null on a desk that predates it. */
  readonly chat: McChatSettings | null;
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
  const chat = engine?.['chat'] as Record<string, unknown> | undefined;
  return {
    chat:
      chat === undefined || chat === null || typeof chat !== 'object'
        ? null
        : {
            providerLabel: typeof chat['providerLabel'] === 'string' ? chat['providerLabel'] : 'Unknown provider',
            baseUrl: typeof chat['baseUrl'] === 'string' ? chat['baseUrl'] : null,
            model: typeof chat['model'] === 'string' ? chat['model'] : null,
            hasKey: chat['hasKey'] === true,
            problem: typeof chat['problem'] === 'string' ? chat['problem'] : null,
          },
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

/** A pairing waiting for its device (D-2): what the desk shows, now on Mission Control too. */
export interface McPairing {
  /** The one-time code, ten characters without a separator. */
  readonly code: string;
  readonly url: string;
  readonly deviceName: string;
  readonly readOnly: boolean;
  readonly expiresAt: string;
  /** The QR code of `url`, one string of `0`/`1` per row. */
  readonly qr: readonly string[];
}

/** The engine's answer to a pairing call: the waiting pairing (or none) and the "set the device address" case. */
export interface McPairingView {
  readonly pairing: McPairing | null;
  readonly needsPublicUrl: boolean;
}

/** Reads a pairing answer tolerantly; null = not a pairing answer. */
export function parsePairingView(json: unknown): McPairingView | null {
  if (typeof json !== 'object' || json === null || (json as Record<string, unknown>)['ok'] !== true) {
    return null;
  }
  const body = json as Record<string, unknown>;
  const p = body['pairing'] as Record<string, unknown> | null | undefined;
  const needsPublicUrl = body['needsPublicUrl'] === true;
  if (p === null || p === undefined) {
    return { pairing: null, needsPublicUrl };
  }
  if (
    typeof p !== 'object' ||
    typeof p['code'] !== 'string' ||
    typeof p['url'] !== 'string' ||
    typeof p['expiresAt'] !== 'string' ||
    !Array.isArray(p['qr'])
  ) {
    return null;
  }
  return {
    needsPublicUrl,
    pairing: {
      code: p['code'],
      url: p['url'],
      deviceName: typeof p['deviceName'] === 'string' ? p['deviceName'] : 'Phone',
      readOnly: p['readOnly'] === true,
      expiresAt: p['expiresAt'],
      qr: p['qr'].filter((row): row is string => typeof row === 'string'),
    },
  };
}

/** "XXXXX-XXXXX" — the code as it is typed. */
export function groupedCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** "4:32" until the code expires; "0:00" once it has. */
export function countdownOf(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The QR as one SVG path of unit squares (dark modules); `size` is the grid edge. */
export function qrPathOf(rows: readonly string[]): { readonly d: string; readonly size: number } {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') {
        d += `M${x + 4} ${y + 4}h1v1h-1z`;
      }
    }
  });
  // Four modules of quiet zone on every side.
  return { d, size: rows.length + 8 };
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
  /** The Chat row's "Test connection": probes the endpoint the chat would use. Optional: a desk without it hides the button. */
  testChat?(): Promise<McChatTest>;
  /** The pairing waiting for a device, started from here (D-2); absent = this client cannot pair. */
  readonly pairingView?: Signal<McPairingView | null>;
  /** Starts a pairing (name, read-only); the engine refuses a read-only device. */
  startPairing?(name: string, readOnly: boolean): Promise<McSettingsReply>;
  cancelPairing?(): Promise<McSettingsReply>;
  /** Re-reads the waiting pairing; once it is gone (used or expired) the device list reloads. */
  refreshPairing?(): Promise<void>;
}

export const MC_SETTINGS_STATE = new InjectionToken<McSettingsState>('mc.settings-state');
