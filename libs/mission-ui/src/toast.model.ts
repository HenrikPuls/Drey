/**
 * The toast pill's state contract, as the lib sees it (`@mission-ui`): the
 * Toast component renders whatever a `McToastState` exposes and never
 * imports the app's `McState` — mission-control's app.config binds its
 * `McState` to `MC_TOAST_STATE` (useExisting), and any other host app
 * provides its own pill state the same way.
 */
import { InjectionToken, type Signal } from '@angular/core';

/** The toast accent's kinds — the same vocabulary the app's api layer uses. */
export type McToastKind = 'ok' | 'warn' | 'error';

/** One toast: the message and the kind tint. */
export interface ToastMessage {
  readonly message: string;
  readonly kind: McToastKind;
}

/** Exactly what the toast pill consumes: the current message, null while hidden. */
export interface McToastState {
  readonly toastMessage: Signal<ToastMessage | null>;
}

/** The shell binds its state store to this token (mission-control: McState). */
export const MC_TOAST_STATE = new InjectionToken<McToastState>('mc.toast-state');
