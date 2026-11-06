/**
 * The tickets plugin's status-bar items (SDK 1.38/1.46; boards 7a, 7h):
 * today's cost ("$4.10 of $15 today", neutral grey, tooltip "so far"),
 * "3 need you" with the orange dot (orange only ever means needs-you), and
 * the Autopilot item ("Autopilot · On", green dot). This file is the pure
 * half plus a small controller over `api.ui.createStatusItem`; the plugin
 * entry feeds it the numbers.
 */
import type { StatusItemHandle, StatusItemSpec } from '../../../shared/plugin-api/renderer';
import type { ChainMaster } from '../../../packages/tickets-engine/src/fleet/protocol';

/** What the three items are derived from. */
export interface StatusSlotInput {
  /** Today's cost in dollars; null = nothing known (the item hides). */
  readonly cost: number | null;
  /** Today's budget in dollars; null = no budget set. */
  readonly budget: number | null;
  /** Tickets and alerts that wait on the owner. */
  readonly needsYou: number;
  /** The chain master; null = no chain config yet (the Autopilot item hides). */
  readonly master: ChainMaster | null;
  /** True while the Notes view is active: the needs-you item then says where. */
  readonly inNotesView: boolean;
}

/** The part of a status item this file decides; empty text = hidden. */
export type StatusSlotPatch = Pick<StatusItemSpec, 'text' | 'tooltip' | 'dot'>;

export interface StatusSlots {
  readonly cost: StatusSlotPatch;
  readonly needs: StatusSlotPatch;
  readonly autopilot: StatusSlotPatch;
}

const HIDDEN: StatusSlotPatch = { text: '' };

/** `$4.10`, and `$15` for a whole budget (the status line is short). */
function dollars(value: number, whole: boolean): string {
  return whole && Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

export function costSlotOf(cost: number | null, budget: number | null): StatusSlotPatch {
  if (cost === null) {
    return HIDDEN;
  }
  // TODO(i18n): "of", "today", "so far"
  const of = budget === null ? '' : ` of ${dollars(budget, true)}`;
  return { text: `${dollars(cost, false)}${of} today`, tooltip: 'so far' };
}

export function needsSlotOf(needsYou: number, inNotesView: boolean): StatusSlotPatch {
  if (needsYou <= 0) {
    return HIDDEN;
  }
  // TODO(i18n): "need you", "needs you", "in Work"
  const text = `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you${inNotesView ? ' in Work' : ''}`;
  return { text, tooltip: 'Open the Tickets panel', dot: 'attention' };
}

/** The chord the Autopilot switch is bound to (concept 6.1). */
export const AUTOPILOT_CHORD = 'Mod+Alt+P';

/**
 * The Autopilot item. TODO(req-95b): today only run / halted exist, mapped
 * to On / Off; the three-state engine state (On / Paused / Off, concept
 * 6.1) and the click that cycles it arrive with req-95b.
 */
export function autopilotSlotOf(master: ChainMaster | null): StatusSlotPatch {
  if (master === null) {
    return HIDDEN;
  }
  const word = master === 'run' ? 'On' : 'Off'; // TODO(i18n)
  return {
    text: `Autopilot · ${word}`,
    tooltip: `Autopilot: ${word} (${AUTOPILOT_CHORD})`,
    ...(master === 'run' ? { dot: 'positive' as const } : {}),
  };
}

export function statusSlotsOf(input: StatusSlotInput): StatusSlots {
  return {
    cost: costSlotOf(input.cost, input.budget),
    needs: needsSlotOf(input.needsYou, input.inNotesView),
    autopilot: autopilotSlotOf(input.master),
  };
}

/** The old combined text ("2 running · 3 need you"); superseded by `statusSlotsOf`, kept until the entry switches. */
export function statusSlotText(running: number, needsYou: number): string {
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (needsYou > 0) {
    parts.push(`${needsYou} need you`);
  }
  return parts.join(' · ');
}

export interface StatusSlotHost {
  createStatusItem(spec: StatusItemSpec): StatusItemHandle;
}

export interface StatusSlotController {
  update(input: StatusSlotInput): void;
  dispose(): void;
}

/**
 * Creates the three items (left to right: cost, needs-you, Autopilot) and
 * returns the controller that keeps them current. `needsCommandId` is the
 * command a click on the needs-you item runs.
 */
export function createStatusSlots(host: StatusSlotHost, needsCommandId: string): StatusSlotController {
  const cost = host.createStatusItem({ text: '', priority: 12 });
  const needs = host.createStatusItem({ text: '', commandId: needsCommandId, priority: 11 });
  const autopilot = host.createStatusItem({ text: '', priority: 10 });
  const apply = (handle: StatusItemHandle, patch: StatusSlotPatch): void => {
    handle.update({ text: patch.text, tooltip: patch.tooltip, dot: patch.dot });
  };
  return {
    update(input) {
      const slots = statusSlotsOf(input);
      apply(cost, slots.cost);
      apply(needs, slots.needs);
      apply(autopilot, slots.autopilot);
    },
    dispose() {
      cost.dispose();
      needs.dispose();
      autopilot.dispose();
    },
  };
}
