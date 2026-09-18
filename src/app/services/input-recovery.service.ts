import { DestroyRef, Injectable, inject } from '@angular/core';
import { EditTargetService } from './edit-target.service';
import { ImageLightboxService } from '../image-viewer';
import { LogService } from './log.service';

/**
 * A best-effort "unstick the keyboard" routine, plus a light watchdog.
 *
 * The project owner hits an intermittent state in the packaged build where
 * **no** input field accepts typed text (mouse selection / copy still
 * work) and only an app restart clears it. One trigger is now known: a
 * dismissed native `confirm()`/`alert()` leaves the Windows window
 * without keyboard focus (electron#41602 -- Alt+Tab there and back
 * clears it); those dialogs are gone from the renderer (replaced by
 * `ConfirmDialogService`), and main's recover handler calls
 * `refocusRenderer()` as well. Main-side native dialogs refocus through
 * `electron/focus.ts`. The less reproducible field reports stay covered
 * the original way: a manual escape hatch wired to a menu item + chord,
 * and a periodic check that clears the obvious "leftover overlay /
 * gesture" states on its own. Every action is logged (ADR-0032) so a
 * field occurrence leaves a trace.
 */
@Injectable({ providedIn: 'root' })
export class InputRecoveryService {
  private readonly editTarget = inject(EditTargetService);
  private readonly lightbox = inject(ImageLightboxService);
  private readonly log = inject(LogService);

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopWatchdog());
  }

  /**
   * Clears every "stuck" state we know how to clear and puts focus back in
   * a sane place. Safe to call at any time.
   */
  recover(reason: string): void {
    this.log.record('warn', `input recovery (${reason})`, this.snapshot());

    // 1. Dismiss any open overlay the Angular way -- every menu, the
    //    lightbox and the confirmation dialog close on a document Escape.
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch {
      /* jsdom / old engine */
    }
    this.lightbox.close();

    // 2. Undo the global gesture side effects (dock drag / image pan set
    //    these on <body> and only clear them on their own pointerup).
    try {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    } catch {
      /* ignore */
    }

    // 3. Remove a backdrop element that outlived its menu (its click
    //    handler is gone, so it just sits over the app swallowing events).
    document.querySelectorAll('.ctx-backdrop').forEach((el) => el.remove());

    // 4. Ask main to close a native context-menu popup that never unwound
    //    (bug-6): invisible to the renderer, it swallows every keystroke
    //    while the mouse keeps working. Best-effort -- no bridge (plain
    //    `ng serve`, tests) simply skips it.
    try {
      void window.dreyApi?.recoverInputFocus?.().then((closed) => {
        if (closed) {
          this.log.record('warn', 'input recovery: main closed a stuck native popup', undefined);
        }
      });
    } catch {
      /* ignore */
    }

    // 5. Move focus off whatever holds it and back into the editor (or the
    //    body), so the next keystroke lands somewhere live.
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      const view = this.editTarget.view;
      if (view && view.dom.isConnected) {
        view.focus();
      } else {
        document.body.focus();
      }
    } catch {
      /* ignore */
    }
  }

  /** Starts the periodic self-check. Idempotent. */
  startWatchdog(): void {
    if (this.timer || typeof window === 'undefined') {
      return;
    }
    this.timer = setInterval(() => this.tick(), 4000);
  }

  stopWatchdog(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One diagnostic pass; auto-recovers on a clear telltale. */
  private tick(): void {
    if (!document.hasFocus()) {
      return; // another app is in front -- nothing to judge here
    }
    const stuck = this.detectStuck();
    if (stuck) {
      this.recover(`watchdog: ${stuck}`);
    }
  }

  /** The states that unambiguously indicate a leftover; `null` when healthy. */
  private detectStuck(): string | null {
    // A lightbox flagged open but with no overlay actually painted.
    if (this.lightbox.src() && !document.querySelector('app-image-lightbox .backdrop')) {
      return 'lightbox src set, no overlay';
    }
    // A context-menu backdrop with no matching menu next to it.
    const backdrop = document.querySelector('.ctx-backdrop');
    if (backdrop && !document.querySelector('.ctx-menu')) {
      return 'orphan ctx-backdrop';
    }
    // <body> left unselectable by a gesture that never ended.
    if (document.body.style.userSelect === 'none' && !document.querySelector('.cm-editor:focus-within')) {
      // Only when nothing is mid-drag: the dock/image gestures set a data
      // attribute for exactly this check.
      if (!document.body.hasAttribute('data-drey-gesture')) {
        return 'body user-select:none, no active gesture';
      }
    }
    return null;
  }

  /** A compact state snapshot for the log. */
  private snapshot(): Record<string, unknown> {
    const active = document.activeElement as HTMLElement | null;
    return {
      hasFocus: document.hasFocus(),
      activeElement: active
        ? {
            tag: active.tagName,
            cls: active.className || undefined,
            connected: active.isConnected,
            inEditor: !!active.closest?.('.cm-editor'),
          }
        : null,
      backdrops: document.querySelectorAll('.ctx-backdrop').length,
      ctxMenus: document.querySelectorAll('.ctx-menu').length,
      lightboxSrcSet: this.lightbox.src() != null,
      bodyUserSelect: document.body.style.userSelect || undefined,
      bodyCursor: document.body.style.cursor || undefined,
      gestureFlag: document.body.hasAttribute('data-drey-gesture'),
    };
  }
}
