import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import {
  fitScale,
  IMAGE_ZOOM_STEP,
  IMAGE_ZOOM_WHEEL_SENSITIVITY,
  zoomToward,
} from '../../../shared/image-zoom';

/**
 * The shared zoom / pan image canvas -- one instance backs the fullscreen
 * lightbox and the `kind: 'image'` editor tab (ADR-0026), the same way
 * `MarkdownSurface` backs the full-page editor and the entry drawer.
 *
 * Plain mouse wheel zooms toward the cursor; drag pans; `+` / `-` / `0`
 * and the on-screen cluster call the same methods. `fit()` scales the
 * image to the stage without ever upscaling past 100%.
 */
@Component({
  selector: 'app-image-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.css',
})
export class ImageViewer implements AfterViewInit, OnDestroy {
  readonly src = input.required<string>();

  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private readonly imgRef = viewChild.required<ElementRef<HTMLImageElement>>('img');

  private readonly _scale = signal(1);
  private readonly offset = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /** Current zoom multiplier. Read by hosts (status bar, meta bar). */
  readonly scale = this._scale.asReadonly();
  /** Intrinsic pixel size once the image has loaded; `{0,0}` for an SVG / not-yet-loaded. */
  readonly natural = signal<{ w: number; h: number }>({ w: 0, h: 0 });
  readonly zoomPercent = computed(() => Math.round(this._scale() * 100));
  protected readonly loadError = signal(false);

  protected readonly transform = computed(() => {
    const { x, y } = this.offset();
    return `translate(${x}px, ${y}px) scale(${this._scale()})`;
  });

  private panCleanup: (() => void) | null = null;

  constructor() {
    // A new src is a fresh image: drop the old geometry so `fit()` re-runs
    // from `(load)`.
    effect(() => {
      this.src();
      this._scale.set(1);
      this.offset.set({ x: 0, y: 0 });
      this.natural.set({ w: 0, h: 0 });
      this.loadError.set(false);
    });

    inject(DestroyRef).onDestroy(() => this.panCleanup?.());
  }

  ngAfterViewInit(): void {
    // Angular host `(wheel)` bindings are passive, so `preventDefault()`
    // wouldn't take -- attach the listener by hand (mirrors
    // `EditorZoomService`). The global Ctrl+wheel guard only
    // `preventDefault`s and never `stopPropagation`s, so this still fires.
    this.stage().nativeElement.addEventListener('wheel', this.onWheel, { passive: false });
  }

  ngOnDestroy(): void {
    this.stage().nativeElement.removeEventListener('wheel', this.onWheel);
  }

  protected onLoad(): void {
    const img = this.imgRef().nativeElement;
    this.natural.set({ w: img.naturalWidth, h: img.naturalHeight });
    this.fit();
  }

  protected onImgError(): void {
    this.loadError.set(true);
  }

  zoomIn(): void {
    this.zoomAboutCentre(IMAGE_ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomAboutCentre(1 / IMAGE_ZOOM_STEP);
  }

  reset100(): void {
    this._scale.set(1);
    this.offset.set({ x: 0, y: 0 });
  }

  fit(): void {
    const box = this.stageBox();
    this._scale.set(fitScale(this.natural(), box));
    this.offset.set({ x: 0, y: 0 });
  }

  private stageBox(): { w: number; h: number } {
    const el = this.stage().nativeElement;
    return { w: el.clientWidth, h: el.clientHeight };
  }

  private stageCentre(): { x: number; y: number } {
    const box = this.stageBox();
    return { x: box.w / 2, y: box.h / 2 };
  }

  private zoomAboutCentre(factor: number): void {
    const centre = this.stageCentre();
    const next = zoomToward(
      { scale: this._scale(), offsetX: this.offset().x, offsetY: this.offset().y },
      centre,
      centre,
      factor,
    );
    this._scale.set(next.scale);
    this.offset.set({ x: next.offsetX, y: next.offsetY });
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.stage().nativeElement.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-event.deltaY * IMAGE_ZOOM_WHEEL_SENSITIVITY);
    const next = zoomToward(
      { scale: this._scale(), offsetX: this.offset().x, offsetY: this.offset().y },
      cursor,
      this.stageCentre(),
      factor,
    );
    this._scale.set(next.scale);
    this.offset.set({ x: next.offsetX, y: next.offsetY });
  };

  protected onPanStart(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const el = this.stage().nativeElement;
    el.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const startX = event.clientX;
    const startY = event.clientY;
    const start = this.offset();
    let moved = false;

    const move = (ev: PointerEvent): void => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) {
        moved = true;
      }
      this.offset.set({ x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) });
    };
    const end = (): void => {
      el.releasePointerCapture?.(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.panCleanup = null;
      if (moved) {
        // A real pan synthesises a `click` on release. Swallow that one
        // click (capture phase) so the lightbox backdrop doesn't read the
        // end of a drag as "clicked outside the image" and close --
        // otherwise the diagram can't be dragged around at all.
        const swallow = (ce: Event): void => {
          ce.stopPropagation();
          ce.preventDefault();
          window.removeEventListener('click', swallow, true);
        };
        window.addEventListener('click', swallow, true);
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      }
    };
    this.panCleanup = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  }
}
