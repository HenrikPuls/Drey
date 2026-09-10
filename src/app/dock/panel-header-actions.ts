import {
  DestroyRef,
  Directive,
  Injectable,
  TemplateRef,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';

/**
 * Holds the header-control templates dock panels contribute to their
 * `PanelFrame` header (req-7): a panel's own control row (scope toggle,
 * refresh button, auto-summary switch, …) is rendered in the shared 32px
 * header instead of as a band under it.
 *
 * A deliberately leaf service -- it imports nothing from `dock/` (not
 * `DockService`, not the widget registry), so a panel component can depend
 * on it without creating an import cycle back through
 * `widget-registry.ts` (which references every panel class).
 */
@Injectable({ providedIn: 'root' })
export class PanelHeaderActionsStore {
  private readonly map = signal<ReadonlyMap<string, TemplateRef<unknown>>>(new Map());

  set(id: string, tpl: TemplateRef<unknown>): void {
    this.map.update((m) => new Map(m).set(id, tpl));
  }

  /** Remove only if `tpl` is still the registered one -- guards a panel-move destroy/recreate race. */
  clear(id: string, tpl: TemplateRef<unknown>): void {
    this.map.update((m) => {
      if (m.get(id) !== tpl) {
        return m;
      }
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }

  get(id: string): TemplateRef<unknown> | null {
    return this.map().get(id) ?? null;
  }
}

/**
 * Marks an `<ng-template>` in a dock panel body as that panel's header
 * controls (req-7). The template is pulled out of the body and rendered in
 * the shared `PanelFrame` header.
 *
 * Usage: `<ng-template appPanelHeaderActions="tasks"> …buttons… </ng-template>`
 *
 * The panel body is projected content (its injector context is `Dock`, not
 * `PanelFrame`), so it cannot hand the template to the frame by DI -- it
 * registers with the root `PanelHeaderActionsStore` keyed by widget id and
 * `PanelFrame` reads it back. Bindings inside the template still resolve
 * against the panel component that declared it.
 */
@Directive({
  selector: 'ng-template[appPanelHeaderActions]',
})
export class PanelHeaderActions {
  /** The widget id of the panel this template belongs to. */
  readonly appPanelHeaderActions = input.required<string>();

  private readonly tpl = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly store = inject(PanelHeaderActionsStore);

  constructor() {
    afterNextRender(() => this.store.set(this.appPanelHeaderActions(), this.tpl));
    inject(DestroyRef).onDestroy(() => this.store.clear(this.appPanelHeaderActions(), this.tpl));
  }
}
