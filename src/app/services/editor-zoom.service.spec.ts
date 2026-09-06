import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EDITOR_FONT_SCALE_STEP } from '../../../shared/app-config';
import { EditorZoomService } from './editor-zoom.service';
import { SettingsService } from './settings.service';

/**
 * A stand-in for `SettingsService`: a writable scale signal plus a
 * `setEditorFontScale` that records its argument and echoes it back into
 * the signal, so `EditorZoomService` sees the same read-after-write the
 * real service gives it.
 */
function fakeSettings() {
  const scale = signal(1);
  const calls: number[] = [];
  const service = {
    editorFontScale: scale.asReadonly(),
    setEditorFontScale: (next: number) => {
      calls.push(next);
      scale.set(next);
      return Promise.resolve();
    },
  } as unknown as SettingsService;
  return { service, scale, calls };
}

function keydown(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent;
}

describe('EditorZoomService', () => {
  let harness: ReturnType<typeof fakeSettings>;
  let service: EditorZoomService;

  beforeEach(() => {
    harness = fakeSettings();
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsService, useValue: harness.service }],
    });
    service = TestBed.inject(EditorZoomService);
  });

  it('exposes the live scale from settings', () => {
    expect(service.scale()).toBe(1);
    harness.scale.set(1.4);
    expect(service.scale()).toBe(1.4);
  });

  it('steps up by one step on Ctrl+"+" and Ctrl+"=" (same physical key)', () => {
    expect(service.handleKey(keydown('+', { ctrlKey: true }))).toBe(true);
    expect(harness.calls.at(-1)).toBeCloseTo(1 + EDITOR_FONT_SCALE_STEP);

    expect(service.handleKey(keydown('=', { ctrlKey: true }))).toBe(true);
    expect(harness.calls.at(-1)).toBeCloseTo(1 + 2 * EDITOR_FONT_SCALE_STEP);
  });

  it('steps down on Ctrl+"-" and resets on Ctrl+"0"', () => {
    harness.scale.set(1.5);
    expect(service.handleKey(keydown('-', { metaKey: true }))).toBe(true);
    expect(harness.calls.at(-1)).toBeCloseTo(1.4);

    expect(service.handleKey(keydown('0', { ctrlKey: true }))).toBe(true);
    expect(harness.calls.at(-1)).toBe(1);
  });

  it('ignores the keys without a modifier, with Alt held, or on other keys', () => {
    expect(service.handleKey(keydown('+'))).toBe(false);
    expect(service.handleKey(keydown('+', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(service.handleKey(keydown('s', { ctrlKey: true }))).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });

  it('suppresses Ctrl+wheel on window so Chromium cannot zoom the chrome', () => {
    const zoomWheel = new WheelEvent('wheel', { ctrlKey: true, cancelable: true });
    window.dispatchEvent(zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(true);

    const plainWheel = new WheelEvent('wheel', { cancelable: true });
    window.dispatchEvent(plainWheel);
    expect(plainWheel.defaultPrevented).toBe(false);
  });
});
