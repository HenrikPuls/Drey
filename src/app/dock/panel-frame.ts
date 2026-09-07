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
import { Icon } from '../icons/icon';
import { DockService, PanelId } from './dock.service';
import { PANEL_TITLES } from './panels/panel-registry';

/**
 * The chrome every dock panel shares (DESIGN.md principle 3): a 32px header
 * with a collapse chevron, the mono-uppercase title, an optional status
 * value and a drag grip -- then the panel body (`<ng-content>`).
 *
 * The body scrolls, except for the assistant panel, which fills the frame
 * and scrolls internally (its own header + composer stay put).
 *
 * `mousedown` on the header (but not the chevron) starts a panel drag via
 * `DockService`; the chevron toggles collapse.
 */
@Component({
  selector: 'app-panel-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
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
  protected readonly flush = computed(() => this.panelId() === 'assistant');
  protected readonly isDragging = computed(() => this.dock.dragging() === this.panelId());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dock.unregisterPanelEl(this.panelId(), this.el));
  }

  ngOnInit(): void {
    this.dock.registerPanelEl(this.panelId(), this.el);
  }

  protected startDrag(event: MouseEvent): void {
    this.dock.startPanelDrag(this.panelId(), event);
  }

  protected toggleCollapse(event: MouseEvent): void {
    // Stop the header drag from starting on the chevron.
    event.stopPropagation();
    this.dock.toggleCollapse(this.panelId());
  }
}
