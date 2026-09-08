import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { ImageViewer } from './image-viewer';
import { IMAGE_SCALE_MAX, IMAGE_SCALE_MIN } from '../../../shared/image-zoom';

/** A 1x1 PNG data URL — jsdom won't decode it, so tests set naturalWidth by hand. */
const SRC = 'data:image/png;base64,iVBORw0KGgo=';

@Component({
  imports: [ImageViewer],
  template: '<app-image-viewer [src]="src()" style="width:800px;height:600px" />',
})
class Host {
  readonly src = signal(SRC);
}

describe('ImageViewer', () => {
  let fixture: ComponentFixture<Host>;
  let viewer: ImageViewer;
  let stage: HTMLElement;
  let img: HTMLImageElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    viewer = fixture.debugElement.children[0].componentInstance;
    stage = el.querySelector('.stage')!;
    img = el.querySelector('img')!;
  });

  function fireLoad(w: number, h: number): void {
    Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();
  }

  it('records the natural size on load', () => {
    fireLoad(1200, 900);
    expect(viewer.natural()).toEqual({ w: 1200, h: 900 });
  });

  it('zooms in / out and resets to 100%', () => {
    fireLoad(100, 100); // small image -> fit() = 1
    expect(viewer.scale()).toBe(1);

    viewer.zoomIn();
    expect(viewer.scale()).toBeGreaterThan(1);
    const zoomed = viewer.scale();

    viewer.zoomOut();
    expect(viewer.scale()).toBeLessThan(zoomed);

    viewer.zoomIn();
    viewer.reset100();
    expect(viewer.scale()).toBe(1);
    expect(viewer.zoomPercent()).toBe(100);
  });

  it('zooms on a plain wheel event and prevents the default scroll', () => {
    fireLoad(100, 100);
    const before = viewer.scale();
    const event = new WheelEvent('wheel', {
      deltaY: -240,
      clientX: 10,
      clientY: 10,
      cancelable: true,
    });
    stage.dispatchEvent(event);
    fixture.detectChanges();

    expect(viewer.scale()).toBeGreaterThan(before);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the scale within [MIN, MAX] under repeated zoom', () => {
    fireLoad(100, 100);
    for (let i = 0; i < 60; i++) {
      viewer.zoomIn();
    }
    expect(viewer.scale()).toBe(IMAGE_SCALE_MAX);
    for (let i = 0; i < 120; i++) {
      viewer.zoomOut();
    }
    expect(viewer.scale()).toBe(IMAGE_SCALE_MIN);
  });

  it('pans with a pointer drag', () => {
    fireLoad(100, 100);
    stage.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 25 }));
    fixture.detectChanges();
    expect((viewer as unknown as { transform: () => string }).transform()).toContain(
      'translate(40px, 25px)',
    );
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  });

  it('re-fits when the src changes', () => {
    fireLoad(100, 100);
    viewer.zoomIn();
    expect(viewer.scale()).not.toBe(1);

    fixture.componentInstance.src.set('data:image/png;base64,AAAA');
    fixture.detectChanges();
    expect(viewer.scale()).toBe(1);
    expect(viewer.natural()).toEqual({ w: 0, h: 0 });
  });

  it('drops the wheel listener on destroy', () => {
    fireLoad(100, 100);
    fixture.destroy();
    const event = new WheelEvent('wheel', { deltaY: -240, cancelable: true });
    stage.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
