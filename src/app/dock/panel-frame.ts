import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
} from '@angular/core';
import { DockService, PanelId } from './dock.service';
import { PANEL_TITLES } from './panels/panel-registry';

/**
 * The chrome every dock panel shares (DESIGN.md principle 3): a 32px
 * low-profile header (the mono-uppercase title + an optional status value +
 * a drag grip), then the panel body (`<ng-content>`).
 *
 * The body scrolls, except for the assistant panel, which fills the frame
 * and scrolls internally (its own header + composer stay put). It stays
 * mounted while collapsed so its state survives; `.body-wrap` animates the
 * height between the two.
 *
 * `mousedown` on the header opens a press gesture in `DockService`: a click
 * (no movement) toggles collapse, a drag past the threshold moves the panel
 * between docks. Enter / Space on the focused header also toggles.
 */
@Component({
  selector: 'app-panel-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './panel-frame.html',
  styleUrl: './panel-frame.css',
  host: {
    '[class.dragging]': 'isDragging()',
  },
})
export class PanelFrame implements OnInit {
  private readonly dock = inject(DockService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly panelId = input.required<PanelId>();
  readonly status = input<string | null>(null);

  protected readonly title = computed(() => PANEL_TITLES[this.panelId()]);
  protected readonly collapsed = computed(() => this.dock.collapsed(this.panelId()));
  /**
   * Panels whose body fills the frame (a flex column) instead of
   * scrolling: the assistant (own header + composer stay put) and the
   * "Add entry" drawer (its text field grows with the panel).
   */
  protected readonly flush = computed(
    () => this.panelId() === 'assistant' || this.panelId() === 'entry',
  );
  protected readonly isDragging = computed(() => this.dock.dragging() === this.panelId());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterPanelEl(this.panelId(), this.el));
  }

  ngOnInit(): void {
    this.dock.registerPanelEl(this.panelId(), this.el);
  }

  protected onHeaderPress(event: MouseEvent): void {
    this.dock.beginHeaderPress(this.panelId(), this.title(), event);
  }

  protected onHeaderKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.dock.toggleCollapse(this.panelId());
    }
  }
}
