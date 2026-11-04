/**
 * The paired-devices list as both screens show it (D-2, milestone 135).
 * This is a local copy of `packages/tickets-engine/src/contracts/device-list.ts`
 * (the lib imports nothing from the repo, like `team.ts`); the lib's spec
 * runs both against one case table, so the two cannot drift apart.
 */

/** A device as the list needs it (`DeviceView`, plus `current` on Mission Control). */
export interface ListedDevice {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  readonly pairedAt: string;
  readonly lastSeen: string | null;
  readonly current?: boolean;
}

export interface DeviceRow {
  readonly id: string;
  /** The name, with a short id suffix when another device carries the same name. */
  readonly label: string;
  /** "Last connected 04.11.2026, 10:15 · 3 h ago" or "Paired 04.11.2026, not connected yet". */
  readonly line: string;
  readonly current: boolean;
  readonly readOnly: boolean;
  /** Not connected for {@link INACTIVE_AFTER_DAYS} days or more (a marker; nothing is removed). */
  readonly inactive: boolean;
}

export interface DeviceList {
  /** "4 paired devices" / "1 paired device" / "No paired devices". */
  readonly heading: string;
  /** Most recently connected first. */
  readonly rows: readonly DeviceRow[];
}

export const INACTIVE_AFTER_DAYS = 14;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function deviceHeading(count: number): string {
  if (count <= 0) {
    return 'No paired devices';
  }
  return count === 1 ? '1 paired device' : `${count} paired devices`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; '' when the stamp is unreadable. */
export function relativeAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  const age = Math.max(0, now - at);
  if (age < MINUTE) {
    return 'just now';
  }
  if (age < HOUR) {
    return `${Math.floor(age / MINUTE)} min ago`;
  }
  if (age < DAY) {
    return `${Math.floor(age / HOUR)} h ago`;
  }
  return `${Math.floor(age / DAY)} d ago`;
}

/** Locale and zone of the stamps; both default to the runtime's own (the specs pin them). */
export interface StampFormat {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** The local date and time of a stamp ("04.11.2026, 10:15" in a German locale). */
export function localStamp(iso: string, format: StampFormat = {}): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  return new Date(at).toLocaleString(format.locale, { dateStyle: 'short', timeStyle: 'short', timeZone: format.timeZone });
}

function rowOf(d: ListedDevice, duplicate: boolean, now: number, format: StampFormat): DeviceRow {
  const connected = d.lastSeen !== null && !Number.isNaN(Date.parse(d.lastSeen));
  const anchor = connected ? (d.lastSeen as string) : d.pairedAt;
  const anchorTime = Date.parse(anchor);
  let line: string;
  if (connected) {
    const ago = relativeAgo(anchor, now);
    line = `Last connected ${localStamp(anchor, format)}${ago === '' ? '' : ` · ${ago}`}`;
  } else {
    const stamp = localStamp(d.pairedAt, format);
    line = stamp === '' ? 'Not connected yet' : `Paired ${stamp}, not connected yet`;
  }
  return {
    id: d.id,
    label: duplicate ? `${d.name} · ${d.id.slice(0, 4)}` : d.name,
    line,
    current: d.current === true,
    readOnly: d.readOnly,
    inactive: !Number.isNaN(anchorTime) && now - anchorTime >= INACTIVE_AFTER_DAYS * DAY,
  };
}

/** The whole list: the heading and one row per device, newest connection first. */
export function deviceListOf(devices: readonly ListedDevice[], now: number, format: StampFormat = {}): DeviceList {
  const names = new Map<string, number>();
  for (const d of devices) {
    names.set(d.name, (names.get(d.name) ?? 0) + 1);
  }
  const key = (d: ListedDevice): number => {
    const t = Date.parse(d.lastSeen ?? d.pairedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  const rows = [...devices]
    .sort((a, b) => key(b) - key(a))
    .map((d) => rowOf(d, (names.get(d.name) ?? 0) > 1, now, format));
  return { heading: deviceHeading(devices.length), rows };
}
