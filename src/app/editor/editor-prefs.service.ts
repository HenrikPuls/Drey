import { Injectable, signal } from '@angular/core';

/**
 * Which mode the editor shows. One `EditorView` runs all three; `'live'`
 * adds the Live Preview extensions (ADR-0009), `'source'` shows the raw
 * Markdown, `'view'` renders read-only through the Live Preview engine
 * (no reveal-on-selection, links open on a plain click). All share the
 * same typography (`editor-theme.ts`).
 */
export type EditorViewMode = 'source' | 'live' | 'view';

/** `localStorage` key for editor-wide preferences. */
const PREFS_KEY = 'drey.editor';

function readPrefs(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writePrefs(patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    // Private-mode / storage-disabled: a non-persisted session is fine.
  }
}

/**
 * Per-machine editor preferences backed by `localStorage` -- the default
 * view mode a freshly opened note lands in, and whether the line-number
 * gutter is shown. Split out of `EditorService` (ADR-0016 style): the
 * registry/save facade shouldn't also own storage plumbing. `EditorService`
 * injects this and re-exposes `lineNumbers` / `toggleLineNumbers` so its
 * public surface is unchanged for the ~4 consumers (`menu.service`, `App`,
 * the editor surface).
 */
@Injectable({ providedIn: 'root' })
export class EditorPrefsService {
  /**
   * The mode a freshly opened note lands in: whatever the user last switched
   * to via the `⋯` menu, defaulting to `'live'`. A stored `'preview'` (the
   * pre-ADR-0009 name of the rendered mode) migrates to `'live'` by falling
   * through the checks.
   */
  defaultMode(): EditorViewMode {
    const stored = readPrefs()['defaultMode'];
    return stored === 'source' || stored === 'view' ? stored : 'live';
  }

  setDefaultMode(mode: EditorViewMode): void {
    writePrefs({ defaultMode: mode });
  }

  /**
   * Whether the editor shows a line-number gutter. App-wide, persisted per
   * machine like the default view mode. Toggled from the meta bar and
   * View -> "Line numbers".
   */
  readonly lineNumbers = signal(readPrefs()['lineNumbers'] === true);

  toggleLineNumbers(): void {
    this.lineNumbers.update((v) => !v);
    writePrefs({ lineNumbers: this.lineNumbers() });
  }

  /**
   * Whether the editor shows the formatting toolbar above the content.
   * App-wide and persisted like the line numbers; toggled from the
   * editor's `⋯` menu.
   */
  readonly toolbar = signal(readPrefs()['toolbar'] === true);

  toggleToolbar(): void {
    this.toolbar.update((v) => !v);
    writePrefs({ toolbar: this.toolbar() });
  }
}
