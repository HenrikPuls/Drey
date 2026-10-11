import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChildren,
} from '@angular/core';
import { Icon, type IconName } from '../icons/icon';
import { DockService, DockSide, PanelId } from './dock.service';
import { WidgetRegistryService } from './widget-registry.service';

/** One strip button: a panel of this dock, open or closed. */
interface StripItem {
  readonly id: PanelId;
  readonly title: string;
  /** Null for a plugin widget that names no glyph -- `letter` shows instead. */
  readonly icon: IconName | null;
  readonly letter: string;
  readonly open: boolean;
  /** "Show Tasks" / "Hide Tasks". */
  readonly label: string;
  /** The label plus the panel's status value, when it has one. */
  readonly tip: string;
}

/**
 * The icon row at the top of a dock (ADR-0019 later change): one toggle per
 * panel that lives in this dock, in dock order. A click opens or closes the
 * panel, a drag moves it to another slot or dock -- the same press gesture
 * as a panel header, so a closed panel stays movable. A closed panel shows
 * nowhere else; its status value rides the icon's tooltip.
 */
@Component({
  selector: 'app-dock-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './dock-strip.html',
  styleUrl: './dock-strip.css',
})
export class DockStrip {
  protected readonly dock = inject(DockService);
  private readonly registry = inject(WidgetRegistryService);

  readonly side = input.required<DockSide>();

  protected readonly items = computed<StripItem[]>(() => {
    // Tracked so plugin statuses in the tooltips follow the same tick the
    // panel headers re-render on.
    this.registry.statusVersion();
    return this.dock.idsFor(this.side()).map((id) => {
      const descriptor = this.registry.descriptor(id);
      const title = descriptor?.title ?? id;
      const open = !this.dock.closed(id);
      const label = `${open ? 'Hide' : 'Show'} ${title}`;
      const status = descriptor?.status?.({ collapsed: !open }) ?? null;
      return {
        id,
        title,
        icon: descriptor?.icon ?? null,
        letter: title.charAt(0).toUpperCase(),
        open,
        label,
        tip: status === null ? label : `${label} · ${status}`,
      };
    });
  });

  /** The live drop slot while a panel drag targets this dock, else null. */
  protected readonly dropIndex = computed(() =>
    this.dock.dropDock() === this.side() ? this.dock.dropIndex() : null,
  );

  private readonly buttons = viewChildren<ElementRef<HTMLButtonElement>>('btn');

  constructor() {
    // Hand the button boxes to `DockService`: a drag over the strip picks
    // its slot from them.
    effect((onCleanup) => {
      const registered = this.buttons().map((ref) => ({
        id: ref.nativeElement.dataset['widget'] ?? '',
        el: ref.nativeElement,
      }));
      for (const { id, el } of registered) {
        this.dock.registerStripEl(id, el);
      }
      onCleanup(() => {
        for (const { id, el } of registered) {
          this.dock.unregisterStripEl(id, el);
        }
      });
    });
  }

  /**
   * The mouse goes through the press gesture on `mousedown`; this catches
   * the activations that carry no pointer (Enter / Space, assistive tech).
   */
  protected onClick(id: PanelId, event: MouseEvent): void {
    if (event.detail === 0) {
      this.dock.toggle(id);
    }
  }
}
