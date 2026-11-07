/**
 * What the desk surfaces (the Board and Team tabs, the Capacity band;
 * E13-8) need from the plugin's module-level store: the board snapshot,
 * the fleet's runs and chain, the IPC seam and the shared actions. One
 * object built in `index.ts`, so these modules never import it back.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { ChainStatus, RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, MutationResult, TicketCard } from '../shared/tickets';

export interface DeskDeps {
  readonly api: DreyPluginApi;
  snapshot(): BoardSnapshot | null;
  runs(): readonly RunInfo[];
  chain(): ChainStatus | null;
  invoke(method: string, payload?: unknown): Promise<unknown>;
  /** Fires after every board or fleet change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Runs a mutation under the board's busy line and error surface. */
  mutate(label: string, run: () => Promise<unknown>): Promise<MutationResult>;
  /** A chain control (`chainMaster`, `chainAbort`) applied to the shared chain state. */
  chainAction(method: string, payload: unknown): Promise<void>;
  /** Opens or closes the Autopilot popover (the Crew head's chip, board 7f). */
  toggleAutopilot?(): void;
  /** Opens a persona's page (`Edit persona`, board 7f -> 7k). */
  openPersona?(id: string): void;
  /** Opens a ticket as its page (file and thread). */
  openTicket(card: TicketCard): void;
  /** Opens the capture dialog (a new idea lands in the first column). */
  newIdea(): void;
  /** The board's title for a ticket id; null = unknown. */
  titleOf(ticketId: string): string | null;
}

/** A DOM element factory shared by the desk views. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** A text button. */
export function textButton(label: string, className: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', className, label);
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}
