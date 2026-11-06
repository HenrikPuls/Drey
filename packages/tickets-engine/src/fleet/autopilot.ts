/**
 * The Autopilot's pure rules (req-95, concept §6.1, ADR-0077 later
 * change): one record — On, Paused (optionally with a resume time), Off —
 * from which the chain's two-state master is derived. The orchestrator
 * holds the record; nothing here touches a clock or a file.
 */
import type { AutopilotRecord, AutopilotRefusal, ChainMaster, ChainStatus } from './protocol';

export const AUTOPILOT_OFF: AutopilotRecord = { state: 'off' };

/** A zoned ISO instant: a time without a zone would mean something else on every device. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** On dispatches; Paused and Off are the master's gentle halt. */
export function masterOf(record: AutopilotRecord): ChainMaster {
  return record.state === 'on' ? 'run' : 'halted';
}

/** The record behind a plain master call (`setMaster`, the An / Aus buttons). */
export function autopilotOfMaster(mode: ChainMaster): AutopilotRecord {
  return mode === 'run' ? { state: 'on' } : AUTOPILOT_OFF;
}

/**
 * The state a client shows: a runner too old to report the record reads
 * through its master, and no runner at all is Off (the boot rule).
 */
export function autopilotOf(status: Pick<ChainStatus, 'master' | 'autopilot'> | null): AutopilotRecord {
  return status === null ? AUTOPILOT_OFF : (status.autopilot ?? autopilotOfMaster(status.master));
}

const refuse = (code: AutopilotRefusal['code']): AutopilotRefusal => ({ ok: false, error: code, code });

/** The set-state command: `{ state, resumeAt? }`; a resume time only on Paused, zoned, in the future. */
export function parseAutopilotSet(
  body: unknown,
  now: Date,
): { readonly ok: true; readonly value: AutopilotRecord } | AutopilotRefusal {
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const state = obj['state'];
  if (state !== 'on' && state !== 'paused' && state !== 'off') {
    return refuse('bad_state');
  }
  const resumeAt = obj['resumeAt'];
  if (resumeAt === undefined || resumeAt === null) {
    return { ok: true, value: { state } };
  }
  if (state !== 'paused' || typeof resumeAt !== 'string' || !ZONED_INSTANT.test(resumeAt)) {
    return refuse('bad_resume_at');
  }
  const at = Date.parse(resumeAt);
  if (Number.isNaN(at) || at <= now.getTime()) {
    return refuse('bad_resume_at');
  }
  return { ok: true, value: { state, resumeAt: new Date(at).toISOString() } };
}

/** The record as `chain.json` holds it; null when the file has none (an older runner wrote it). */
export function restoreAutopilot(value: unknown): AutopilotRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { state, resumeAt } = value as { state?: unknown; resumeAt?: unknown };
  if (state === 'paused' && typeof resumeAt === 'string' && !Number.isNaN(Date.parse(resumeAt))) {
    return { state, resumeAt };
  }
  return state === 'on' || state === 'off' || state === 'paused' ? { state } : null;
}

/**
 * The boot rule (ADR-0077, O-5): every start ends as Off — also a Paused
 * whose resume time has not passed, and one whose time passed while the
 * runner was down. A handover to a newer build is no start: the record
 * goes on as it stood, a due resume time fires on the successor's tick.
 */
export function autopilotAtBoot(persisted: AutopilotRecord, handedOver: boolean): AutopilotRecord {
  return handedOver ? persisted : AUTOPILOT_OFF;
}

/** True once a Paused record's resume time has come. */
export function resumeDue(record: AutopilotRecord, now: Date): boolean {
  return record.state === 'paused' && record.resumeAt !== undefined && Date.parse(record.resumeAt) <= now.getTime();
}
