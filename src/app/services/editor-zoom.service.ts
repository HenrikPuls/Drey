import { Injectable, inject } from '@angular/core';
import { EDITOR_FONT_SCALE_STEP } from '../../../shared/app-config';
import { SettingsService } from './settings.service';

/**
 * Editor content zoom. `Ctrl +` / `Ctrl -` / `Ctrl 0` and `Ctrl`+wheel,
 * while an editor surface is focused, scale the CodeMirror text only --
 * never the app chrome. The multiplier is persisted in `app-config.json`
 * through `SettingsService` (`editor.fontScale`); this service just maps
 * input events onto steps and owns the one global guard that stops
 * Chromium from zooming the whole window on `Ctrl`+wheel.
 *
 * It replaces the former main-process `webContents.setZoomFactor` zoom
 * (`electron/zoom.ts`, deleted), which scaled the entire renderer.
 */
@Injectable({ providedIn: 'root' })
export class EditorZoomService {
  private readonly settings = inject(SettingsService);

  /** Current multiplier; 1 = the editor theme's base sizes. */
  readonly scale = this.settings.editorFontScale;

  constructor() {
    // Chromium zooms the whole page on Ctrl+wheel by default, which is the
    // "the whole app resizes" behaviour we are moving away from. Suppress
    // it everywhere; the editor surface separately turns Ctrl+wheel into a
    // content font-size step in its own bubble-phase handler (which still
    // runs -- this only calls preventDefault, not stopPropagation).
    // Capture phase + non-passive so preventDefault is honoured.
    if (typeof window !== 'undefined') {
      window.addEventListener('wheel', blockChromeZoom, { passive: false, capture: true });
    }
  }

  stepIn(): void {
    void this.settings.setEditorFontScale(this.scale() + EDITOR_FONT_SCALE_STEP);
  }

  stepOut(): void {
    void this.settings.setEditorFontScale(this.scale() - EDITOR_FONT_SCALE_STEP);
  }

  reset(): void {
    void this.settings.setEditorFontScale(1);
  }

  /**
   * Maps a keydown onto a zoom step. Returns `true` when it was a zoom
   * shortcut -- Ctrl/Cmd (without Alt) plus `+`, `-` or `0`, numpad
   * included -- so the caller can `preventDefault()` and stop there.
   */
  handleKey(event: KeyboardEvent): boolean {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
      return false;
    }
    switch (event.key) {
      case '+':
      case '=': // the same physical key as '+', unshifted
        this.stepIn();
        return true;
      case '-':
      case '_':
        this.stepOut();
        return true;
      case '0':
        this.reset();
        return true;
      default:
        return false;
    }
  }
}

function blockChromeZoom(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
  }
}
