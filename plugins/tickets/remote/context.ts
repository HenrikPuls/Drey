/**
 * The phone client's shared shapes (req-66): what the app keeps, what a
 * view may call back into, and what a view returns.
 */
import type { FleetSnapshot } from '../main/fleet-client';
import type { NeedItem, TicketReply } from '../shared/remote-protocol';
import type { BoardSnapshot, MutationResult } from '../shared/tickets';
import type { Api } from './api';

export interface State {
  actor: string;
  deviceName: string;
  readOnly: boolean;
  board: BoardSnapshot | null;
  fleet: FleetSnapshot | null;
  needs: readonly NeedItem[];
  connected: boolean;
  /** The ticket view's file, by id. */
  ticket: TicketReply | null;
  /** The run view's stream tail (ndjson), by run id. */
  stream: { readonly runId: string; readonly text: string } | null;
}

export interface Ctx {
  readonly api: Api;
  readonly state: State;
  go(hash: string): void;
  /** Fetches everything again and redraws even a form. */
  reload(): void;
  /** Runs a desk call, shows its outcome; true when it went through. */
  act(call: Promise<MutationResult | { ok: boolean; error?: string }>, success: string): Promise<boolean>;
}

export interface View {
  readonly title: string;
  readonly back?: string;
  readonly body: Node[];
  readonly actions?: Node | null;
  /** Keep the page scrolled to its end while it grows (a live transcript). */
  readonly followTail?: boolean;
  /** A form: a live update never redraws it under the typing hand. */
  readonly form?: boolean;
  /** Uses the full width (the iPad kanban) instead of the reading column. */
  readonly wide?: boolean;
}

