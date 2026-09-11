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
import type { PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

/**
 * Renders one plugin-contributed Settings page: a plain `<div>` the
 * plugin's `mount(el)` fills. Plugin pages save immediately through their
 * own `api.settings` (ADR-0044 rule 3) — the surrounding Settings draft /
 * Save / Discard flow does not see them.
 *
 * The mount tracks the `contrib` input, not just the first render: every
 * plugin page renders through THIS one component class, so Angular reuses
 * the instance when the user switches between two plugin pages (e.g. the
 * assistant plugin's "Assistant" and "Actions"), and the outgoing page's
 * cleanup must run before the incoming one fills the div.
 */
@Component({
  selector: 'app-plugin-settings-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #body class="plugin-settings-body"></div>`,
})
export class PluginSettingsHost {
  private readonly log = inject(LogService);

  /** The plugin's page contribution. */
  readonly contrib = input.required<PluginSettingsPageContrib>();

  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');

  constructor() {
    const destroyRef = inject(DestroyRef);
    let dispose: (() => void) | undefined;

    effect(() => {
      const contrib = this.contrib();
      const host = this.body().nativeElement;
      try {
        dispose?.();
      } catch (error) {
        this.log.record('error', `plugin settings page dispose failed: ${String(error)}`);
      }
      dispose = undefined;
      host.textContent = '';
      try {
        dispose = contrib.mount(host) ?? undefined;
      } catch (error) {
        this.log.record(
          'error',
          `plugin settings page "${contrib.id}" mount failed: ${String(error)}`,
        );
      }
    });

    destroyRef.onDestroy(() => {
      try {
        dispose?.();
      } catch (error) {
        this.log.record('error', `plugin settings page dispose failed: ${String(error)}`);
      }
    });
  }
}
