import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import type { PluginDocKindContrib } from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

/**
 * Renders one contributed doc kind's pane body (ADR-0044 stage 8A): a plain
 * `<div>` the contribution's `mount(el, path)` fills — for the browser (still
 * a base feature) the Angular `BrowserTab` mounted imperatively, for plugins
 * plain DOM. `PaneLeaf` picks this over `<app-editor>` whenever the active
 * doc's kind resolves to a `DocKindRegistry` contribution.
 *
 * Like `PluginSettingsHost`, the mount tracks its inputs, not just the first
 * render: the same component instance can move to a different tab (pane
 * reuse), and the outgoing body's cleanup must run before the incoming one
 * fills the div. Focus flips are forwarded to the contribution so a kind can
 * gate its own chords (the browser's find bar).
 */
@Component({
  selector: 'app-plugin-doc-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
    }
    .plugin-doc-body {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
  `,
  template: `<div #body class="plugin-doc-body"></div>`,
})
export class PluginDocHost {
  private readonly log = inject(LogService);

  /** The registered contribution for the shown doc's kind. */
  readonly contrib = input.required<PluginDocKindContrib>();
  /** The doc's registry key (`browser://<n>` for browser tabs). */
  readonly path = input.required<string>();
  /** Is *this pane* the focused one. */
  readonly focused = input(true);

  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');

  constructor() {
    const destroyRef = inject(DestroyRef);
    let dispose: (() => void) | undefined;

    effect(() => {
      const contrib = this.contrib();
      const path = this.path();
      const host = this.body().nativeElement;
      try {
        dispose?.();
      } catch (error) {
        this.log.record('error', `doc kind "${contrib.kind}" dispose failed: ${String(error)}`);
      }
      dispose = undefined;
      host.textContent = '';
      try {
        dispose = contrib.mount(host, path) ?? undefined;
      } catch (error) {
        this.log.record(
          'error',
          `doc kind "${contrib.kind}" mount failed for "${path}": ${String(error)}`,
        );
      }
    });

    effect(() => {
      const contrib = this.contrib();
      const path = this.path();
      const focused = this.focused();
      if (contrib.onFocused === undefined) {
        return;
      }
      try {
        contrib.onFocused(path, focused);
      } catch (error) {
        this.log.record('error', `doc kind "${contrib.kind}" onFocused failed: ${String(error)}`);
      }
    });

    destroyRef.onDestroy(() => {
      try {
        dispose?.();
      } catch (error) {
        this.log.record('error', `doc kind dispose failed: ${String(error)}`);
      }
    });
  }
}
