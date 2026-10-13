import { Injectable, signal } from '@angular/core';
import { EditorView } from '@codemirror/view';
import { type EmojiRecentsStorage, pushEmojiRecent } from './emoji-recents';

/** An open picker: the view plus the range `:name:` will replace. */
export interface EmojiPickerRequest {
  readonly view: EditorView;
  readonly from: number;
  readonly to: number;
  /** Viewport-clamped caret anchor the panel opens at. */
  readonly anchor: { x: number; y: number };
}

/**
 * The `:emoji:` picker (milestone 72, ADR-0070): an App-level overlay over
 * the curated gemoji table, opened wherever a Markdown surface sits -- the
 * toolbar's smile button, the context menu's "Emoji…" row and the `/emoji`
 * slash command all funnel into `open()`. The one place a picked shortcode
 * is inserted, so every entry path lands the identical change (and records
 * the pick as a recent, which the `:`-completion ranks first).
 */
@Injectable({ providedIn: 'root' })
export class EmojiPickerService {
  /** The open request, or `null` while the picker is closed. */
  readonly request = signal<EmojiPickerRequest | null>(null);

  /** Opens the picker over a range of `view`, anchored at that position. */
  open(target: { view: EditorView; from: number; to: number }): void {
    if (target.view.state.readOnly) {
      return;
    }
    this.request.set({ ...target, anchor: this.anchorFor(target.view, target.to) });
  }

  close(): void {
    this.request.set(null);
  }

  /**
   * Inserts `:name:` over the open range, records the pick as a recent and
   * hands focus back to the editor so typing continues right after the
   * shortcode.
   */
  insert(name: string): void {
    const req = this.request();
    if (req === null) {
      return;
    }
    this.close();
    const insert = `:${name}:`;
    req.view.dispatch({
      changes: { from: req.from, to: req.to, insert },
      selection: { anchor: req.from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.emoji',
    });
    req.view.focus();
    pushEmojiRecent(this.storage(), name);
  }

  /** The caret's viewport position, clamped so the panel stays on screen. */
  private anchorFor(view: EditorView, pos: number): { x: number; y: number } {
    try {
      const coords = view.coordsAtPos(pos);
      if (coords !== null) {
        return {
          x: Math.round(Math.max(8, Math.min(coords.left, window.innerWidth - 340))),
          y: Math.round(Math.max(8, Math.min(coords.bottom + 6, window.innerHeight - 380))),
        };
      }
    } catch {
      // the view went away between open and anchor -- fall through
    }
    return { x: Math.round(Math.max(8, window.innerWidth / 2 - 160)), y: 96 };
  }

  /** `localStorage` can throw at access time (sandboxed frames); recents
   *  must never take the picker down with them. */
  private storage(): EmojiRecentsStorage {
    try {
      return globalThis.localStorage;
    } catch {
      return {
        getItem: () => null,
        setItem: () => undefined,
      };
    }
  }
}
