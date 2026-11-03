/**
 * The chat tab's slice of the app state, as the lib sees it (`@mission-ui`):
 * the minimal surface the Chat component consumes, so the component never
 * imports the app's `McState` — the shell (mission-control's app.config)
 * binds its `McState` to `MC_CHAT_STATE` (useExisting), the same adapter
 * pattern the work tab's `MC_WORK_STATE` established.
 */
import { InjectionToken, type Signal, type WritableSignal, signal } from '@angular/core';
import {
  DEFAULT_PRIORITY_CONFIG,
  type ChatStateView,
  type WorkView,
} from '../api/dto';

/**
 * The mutation reply the chat's actions settle on (`McReply` in the app's
 * api layer — the same union, restated here so the lib carries no import
 * from the app).
 */
export type McChatReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The attachment-upload reply: on success the paths the desk stored (each
 * like `tickets/attachments/img-…png`) — an upload is laid down on the
 * desk, not sent into the session, so there is nothing more to report.
 */
export type McChatUploadReply =
  | { readonly ok: true; readonly stored: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Exactly what the chat tab consumes of the app state. */
export interface McChatState {
  /** The report card's one-shot draft prefill; the tab consumes and clears it. */
  readonly chatPrefill: WritableSignal<string | null>;
  /**
   * One-shot: the phone's menu button on another screen sets it and
   * switches to the chat tab; the chat opens its history on mount.
   * Optional — a host without a menu leaves it off.
   */
  readonly chatMenu?: WritableSignal<boolean>;
  /** The session list and the open session — the merged timeline's source. */
  readonly chat: Signal<ChatStateView>;
  /** The raw board snapshot; the proposal cards read it tolerantly. */
  readonly board: Signal<unknown>;
  /** The work view; the phase directory and group titles resolve from it. */
  readonly work: Signal<WorkView>;
  /** Opens a session file as the pane's live one. */
  openSession(file: string): Promise<void>;
  /** Starts a fresh session with `text` as the owner's first message. */
  newSession(text: string): Promise<McChatReply>;
  /** Sends `text` into the open session. */
  send(text: string): Promise<McChatReply>;
  confirm(file: string, id: string): Promise<McChatReply>;
  dismiss(file: string, id: string): Promise<McChatReply>;
  /**
   * Uploads the picked files to the desk's `POST /api/attachments` —
   * optional: a host that does not wire uploads leaves it off and the
   * composer's attach button stays disabled (the unwired fallback does).
   */
  uploadAttachment?(files: File[]): Promise<McChatUploadReply>;
  /** A transient status note (the toast pill); the kind picks the accent. */
  toast(message: string, kind?: 'ok' | 'warn' | 'error'): void;
}

/**
 * The chat tab's slice of the app state. Provided by the shell once, shared
 * with the other tabs; until the shell wires it, the tab renders against a
 * fresh disconnected state (`disconnectedChatState()` — empty list, honest
 * refusal errors), like the prototype's fresh `McState` fallback.
 */
export const MC_CHAT_STATE = new InjectionToken<McChatState>('mc-chat-state');

/**
 * The unwired fallback: an empty session list, a closed board and actions
 * that refuse honestly instead of pretending a desk answered.
 */
export function disconnectedChatState(): McChatState {
  const refuse = (): McChatReply => ({ ok: false, error: 'Not connected.' });
  return {
    chatPrefill: signal<string | null>(null),
    chat: signal<ChatStateView>({ sessions: [], active: null }),
    board: signal<unknown>(null),
    work: signal<WorkView>({ groups: [], priorities: DEFAULT_PRIORITY_CONFIG }),
    openSession: async () => {},
    newSession: async () => refuse(),
    send: async () => refuse(),
    confirm: async () => refuse(),
    dismiss: async () => refuse(),
    toast: () => {},
  };
}
