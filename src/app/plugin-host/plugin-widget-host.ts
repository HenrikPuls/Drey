import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { WidgetRegistryService } from '../dock/widget-registry.service';
import { LogService } from '../services/log.service';

/**
 * The generic body of a plugin-registered dock widget (ADR-0044 rule 2):
 * a plain `<div>` the plugin's `mount(el)` builds into. No Angular
 * machinery crosses the line — the plugin manages its own DOM, the host
 * only owns the lifecycle (mount once the element exists, dispose on
 * destroy).
 */
@Component({
  selector: 'app-plugin-widget-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #body class="plugin-widget-body"></div>`,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        overflow: hidden;
      }
      .plugin-widget-body {
        height: 100%;
        overflow: auto;
      }
    `,
  ],
})
export class PluginWidgetHost {
  private readonly registry = inject(WidgetRegistryService);
  private readonly log = inject(LogService);
  private readonly body = signal<HTMLElement | null>(null);

  /** The widget id whose contribution to mount. */
  readonly widgetId = input.required<string>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef);
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const host = el.nativeElement.querySelector<HTMLElement>('.plugin-widget-body');
      this.body.set(host);
      const contrib = this.registry.contribFor(this.widgetId());
      if (host === null || contrib === undefined) {
        if (contrib === undefined) {
          this.log.record('error', `plugin widget "${this.widgetId()}" is not registered`);
        }
        return;
      }
      let dispose: (() => void) | undefined;
      try {
        dispose = contrib.mount(host) ?? undefined;
      } catch (error) {
        this.log.record('error', `plugin widget "${this.widgetId()}" mount failed: ${String(error)}`);
      }
      destroyRef.onDestroy(() => {
        try {
          dispose?.();
        } catch (error) {
          this.log.record('error', `plugin widget "${this.widgetId()}" dispose failed: ${String(error)}`);
        }
      });
    });
  }
}
