import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
} from '@angular/core';
import type { PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

/**
 * Renders one plugin-contributed Settings page: a plain `<div>` the
 * plugin's `mount(el)` fills. Plugin pages save immediately through their
 * own `api.settings` (ADR-0044 rule 3) — the surrounding Settings draft /
 * Save / Discard flow does not see them.
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

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef);
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const host = el.nativeElement.querySelector<HTMLElement>('.plugin-settings-body');
      if (host === null) {
        return;
      }
      let dispose: (() => void) | undefined;
      try {
        dispose = this.contrib().mount(host) ?? undefined;
      } catch (error) {
        this.log.record('error', `plugin settings page "${this.contrib().id}" mount failed: ${String(error)}`);
      }
      destroyRef.onDestroy(() => {
        try {
          dispose?.();
        } catch (error) {
          this.log.record('error', `plugin settings page "${this.contrib().id}" dispose failed: ${String(error)}`);
        }
      });
    });
  }
}
