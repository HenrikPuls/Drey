/**
 * The Autopilot's client-side pure rules (req-95b, concept 6.1), shared by
 * the desktop status item, Mission Control's chip / sheet / menu row and
 * the Settings row: which dot a state wears, how a refusal code reads, and
 * how a time field becomes the zoned `resumeAt` the engine accepts. The
 * engine half is `packages/tickets-engine/src/fleet/autopilot.ts`.
 */
import type { MessageKey } from './i18n';

export type AutopilotKind = 'on' | 'paused' | 'off';

/** What every client shows: the state and, on Paused, the optional resume instant (zoned ISO). */
export interface AutopilotView {
  readonly state: AutopilotKind;
  readonly resumeAt?: string;
}

export const AUTOPILOT_KINDS: readonly AutopilotKind[] = ['on', 'paused', 'off'];

/** The codes the engine refuses with (`AutopilotRefusal.code`). */
export type AutopilotRefusalCode = 'bad_state' | 'bad_resume_at' | 'runner_down' | 'read_only';

/** Green = On, orange = Paused, grey = Off (canvas board 10t). */
export type AutopilotTone = 'positive' | 'attention' | 'neutral';

export function autopilotToneOf(state: AutopilotKind): AutopilotTone {
  return state === 'on' ? 'positive' : state === 'paused' ? 'attention' : 'neutral';
}

const isKind = (value: unknown): value is AutopilotKind => value === 'on' || value === 'paused' || value === 'off';

/**
 * The state a client shows off a chain block: the engine's record when it
 * has one, else the master it derives from (an older runner), and null when
 * there is no chain config at all (the item hides). Mirrors `autopilotOf`.
 */
export function autopilotViewOf(chain: unknown): AutopilotView | null {
  if (typeof chain !== 'object' || chain === null) {
    return null;
  }
  const { master, autopilot } = chain as { master?: unknown; autopilot?: unknown };
  if (typeof autopilot === 'object' && autopilot !== null) {
    const { state, resumeAt } = autopilot as { state?: unknown; resumeAt?: unknown };
    if (isKind(state)) {
      return state === 'paused' && typeof resumeAt === 'string' ? { state, resumeAt } : { state };
    }
  }
  return master === 'run' ? { state: 'on' } : { state: 'off' };
}

/** The catalog key of a refusal; anything the engine did not name reads as `unknown`. */
export function autopilotRefusalKeyOf(code: unknown): MessageKey {
  return code === 'read_only' || code === 'bad_resume_at' || code === 'bad_state' || code === 'runner_down'
    ? (`autopilot.refused.${code}` as MessageKey)
    : 'autopilot.refused.unknown';
}

/**
 * The refusal code off a reply of any transport: the engine's `code`, or
 * (a 403 whose body a client kept only as text) the read-only wording.
 */
export function autopilotRefusalCodeOf(reply: unknown): AutopilotRefusalCode | null {
  if (typeof reply !== 'object' || reply === null) {
    return null;
  }
  const { code, error } = reply as { code?: unknown; error?: unknown };
  if (code === 'read_only' || code === 'bad_resume_at' || code === 'bad_state' || code === 'runner_down') {
    return code;
  }
  if (typeof error === 'string' && error.includes('read-only')) {
    return 'read_only';
  }
  if (typeof error === 'string' && error.includes('not running')) {
    return 'runner_down';
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * `HH:MM` (a time field's value, the device's own clock) → the next such
 * instant after `now` as a zoned ISO string; null for anything that is not
 * a time. A time already past today means tomorrow.
 */
export function resumeAtOfTime(time: string, now: Date): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at.toISOString();
}

/** A `resumeAt` instant → the `HH:MM` a time field shows (device clock); '' when there is none. */
export function timeFieldOfResume(resumeAt: string | undefined): string {
  if (resumeAt === undefined) {
    return '';
  }
  const at = new Date(resumeAt);
  return Number.isNaN(at.getTime()) ? '' : `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
