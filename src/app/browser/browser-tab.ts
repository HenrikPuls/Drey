import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Icon } from '../icons/icon';
import { BrowserViewService } from './browser-view.service';

/**
 * One pane's chrome for a `kind: 'browser'` tab (ADR-0042), mounted by the
 * browser's `DocKindRegistry` contribution (ADR-0044 stage 8A) through
 * `PluginDocHost`. It renders *only* the toolbar (back /
 * forward / reload / address bar / find) and an empty `.viewport`
 * placeholder -- the page itself is a main-process `WebContentsView`
 * floated on top, matched frame-by-frame to `.viewport`'s client rect.
 *
 * The view is created once (when the tab opens, in `BrowserViewService`)
 * and destroyed when the tab leaves the registry; this component only
 * toggles its visibility (hidden while unmounted, while any Angular overlay
 * is open, or during a layout drag) and streams its bounds.
 */
@Component({
  selector: 'app-browser-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './browser-tab.html',
  styleUrl: './browser-tab.css',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class BrowserTab implements OnDestroy {
  private readonly browser = inject(BrowserViewService);

  /** The tab's `OpenDoc.path` -- `browser://<n>`. */
  readonly tabId = input.required<string>();
  /** ADR-0037: is *this pane* the focused one (gates the find keybinding). */
  readonly focused = input(true);

  private readonly anchor = viewChild.required<ElementRef<HTMLElement>>('anchor');

  protected readonly state = computed(() => this.browser.tabState(this.tabId()));

  /** Local address-bar buffer; `true` while the user is editing it (don't clobber). */
  protected readonly addressDraft = signal('');
  private editingAddress = false;

  private lastRect = '';
  private rafId = 0;
  private resizeObs: ResizeObserver | null = null;
  private mounted = true;

  constructor() {
    // Keep the address bar in step with real navigation unless the user is
    // mid-edit.
    effect(() => {
      const url = this.state()?.url ?? '';
      if (!this.editingAddress) {
        this.addressDraft.set(url === 'about:blank' ? '' : url);
      }
    });

    // The single visibility rule: shown iff mounted and nothing in
    // `BrowserViewService.hidden()` (an overlay, a layout drag) is active.
    effect(() => {
      const visible = this.mounted && !this.browser.hidden();
      this.browser.setVisible(this.tabId(), visible);
      if (visible) {
        this.measure(true);
      }
    });

    effect((onCleanup) => {
      const el = this.anchor().nativeElement;
      this.resizeObs = new ResizeObserver(() => this.measure(false));
      this.resizeObs.observe(el);
      const onWinResize = (): void => this.measure(false);
      window.addEventListener('resize', onWinResize);
      // A cheap rAF poll catches splitter / dock drags (the rect moves
      // every frame with no resize event on this element).
      const tick = (): void => {
        this.measure(false);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
      onCleanup(() => {
        this.resizeObs?.disconnect();
        this.resizeObs = null;
        window.removeEventListener('resize', onWinResize);
        cancelAnimationFrame(this.rafId);
      });
    });
  }

  ngOnDestroy(): void {
    this.mounted = false;
    this.browser.setVisible(this.tabId(), false);
  }

  private measure(force: boolean): void {
    if (this.browser.hidden()) {
      return;
    }
    const r = this.anchor().nativeElement.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (!force && key === this.lastRect) {
      return;
    }
    this.lastRect = key;
    this.browser.setBounds(this.tabId(), {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
  }

  // --- toolbar ------------------------------------------------------

  protected submitAddress(): void {
    this.editingAddress = false;
    this.browser.navigate(this.tabId(), this.addressDraft());
  }

  protected onAddressFocus(): void {
    this.editingAddress = true;
  }

  protected onAddressBlur(): void {
    this.editingAddress = false;
    this.addressDraft.set(this.state()?.url === 'about:blank' ? '' : (this.state()?.url ?? ''));
  }

  protected back(): void {
    this.browser.back(this.tabId());
  }
  protected forward(): void {
    this.browser.forward(this.tabId());
  }
  protected reloadOrStop(): void {
    if (this.state()?.loading) {
      this.browser.stop(this.tabId());
    } else {
      this.browser.reload(this.tabId());
    }
  }

  // --- find bar ---------------------------------------------------

  protected onFindInput(value: string): void {
    this.browser.find(this.tabId(), value, true);
  }

  protected findNext(backwards: boolean): void {
    const q = this.state()?.find.query ?? '';
    if (q) {
      this.browser.find(this.tabId(), q, !backwards);
    }
  }

  protected closeFind(): void {
    this.browser.closeFind(this.tabId());
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.focused()) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.browser.openFind(this.tabId());
    } else if (event.key === 'Escape' && this.state()?.find.open) {
      event.preventDefault();
      this.closeFind();
    }
  }
}
