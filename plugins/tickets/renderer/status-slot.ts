// i18n: catalog
/**
 * The tickets plugin's status-bar items (SDK 1.38/1.46; boards 7a, 7h):
 * today's cost ("$4.10 of $15 today", neutral grey, tooltip "so far"),
 * "3 need you" with the orange dot (orange only ever means needs-you), and
 * the Autopilot item ("Autopilot · On", green dot). This file is the pure
 * half plus a small controller over `api.ui.createStatusItem`; the plugin
 * entry feeds it the numbers.
 */
import type { DreyPluginApi, StatusItemHandle, StatusItemSpec } from '../../../shared/plugin-api/renderer';
import type { AutopilotState } from '../../../packages/tickets-engine/src/fleet/protocol';

/** The catalog's lookup (`api.i18n.t`). */
export type Translate = DreyPluginApi['i18n']['t'];

/** What the three items are derived from. */
export interface StatusSlotInput {
  /** Today's cost in dollars; null = nothing known (the item hides). */
  readonly cost: number | null;
  /** Today's budget in dollars; null = no budget set. */
  readonly budget: number | null;
  /** Tickets and alerts that wait on the owner. */
  readonly needsYou: number;
  /** What the engine reports; null = no chain config yet (the Autopilot item hides). */
  readonly autopilot: AutopilotState | null;
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

export function costSlotOf(cost: number | null, budget: number | null, t: Translate): StatusSlotPatch {
  if (cost === null) {
    return HIDDEN;
  }
  const spent = dollars(cost, false);
  const text = budget === null
    ? t('status.cost.today', { cost: spent })
    : t('status.cost.of_budget', { cost: spent, budget: dollars(budget, true) });
  return { text, tooltip: t('cost.so_far') };
}

export function needsSlotOf(needsYou: number, inNotesView: boolean, t: Translate): StatusSlotPatch {
  if (needsYou <= 0) {
    return HIDDEN;
  }
  const text = t(inNotesView ? 'status.needs_you.in_work' : 'status.needs_you', { n: needsYou });
  return { text, tooltip: t('status.open_tickets_panel'), dot: 'attention' };
}

/** The chord the Autopilot switch is bound to (concept 6.1). */
export const AUTOPILOT_CHORD = 'Mod+Alt+P';

/** The Autopilot item (concept 6.1). TODO(req-95b): the click that changes the state. */
export function autopilotSlotOf(autopilot: AutopilotState | null, t: Translate): StatusSlotPatch {
  if (autopilot === null) {
    return HIDDEN;
  }
  const state = t(`autopilot.state.${autopilot}`);
  return {
    text: t('status.autopilot', { state }),
    tooltip: t('status.autopilot.tooltip', { state, chord: AUTOPILOT_CHORD }),
    ...(autopilot === 'on' ? { dot: 'positive' as const } : {}),
  };
}

export function statusSlotsOf(input: StatusSlotInput, t: Translate): StatusSlots {
  return {
    cost: costSlotOf(input.cost, input.budget, t),
    needs: needsSlotOf(input.needsYou, input.inNotesView, t),
    autopilot: autopilotSlotOf(input.autopilot, t),
  };
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
export function createStatusSlots(host: StatusSlotHost, needsCommandId: string, t: Translate): StatusSlotController {
  const cost = host.createStatusItem({ text: '', priority: 12 });
  const needs = host.createStatusItem({ text: '', commandId: needsCommandId, priority: 11 });
  const autopilot = host.createStatusItem({ text: '', priority: 10 });
  const apply = (handle: StatusItemHandle, patch: StatusSlotPatch): void => {
    handle.update({ text: patch.text, tooltip: patch.tooltip, dot: patch.dot });
  };
  return {
    update(input) {
      const slots = statusSlotsOf(input, t);
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
