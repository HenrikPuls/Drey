import { inject, Injectable } from '@angular/core';
import { EditorService } from '../services/editor.service';

/**
 * Renderer side of the calendar-invite import (ADR-0041). The decoding
 * itself is a main-process concern (`electron/meeting`, `ical.js` /
 * `@kenjiuno/msgreader`); this service is a thin bridge:
 *
 * - `decodeToMarkdown` is called from the editor's drop handler with the
 *   dropped file's bytes and returns the ready-to-insert meeting section;
 * - `importIntoNote` drives the "File → Import meeting …" fallback — a
 *   native picker in main, then insert at the caret of the focused pane.
 */
@Injectable({ providedIn: 'root' })
export class MeetingService {
  private readonly editor = inject(EditorService);

  private get api(): Window['dreyApi'] | undefined {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Drop path: `bytes` + `filename` -> the Markdown meeting section. */
  decodeToMarkdown(bytes: Uint8Array, filename: string): Promise<string> {
    const api = this.api;
    if (typeof api?.decodeMeeting !== 'function') {
      return Promise.reject(new Error('Reading calendar files needs the desktop app.'));
    }
    return api.decodeMeeting(bytes, filename);
  }

  /** Native picker in main, then insert the section at the caret. No-ops with no open note. */
  async importIntoNote(): Promise<void> {
    const api = this.api;
    if (typeof api?.importMeeting !== 'function') {
      return;
    }
    try {
      const block = await api.importMeeting();
      if (block) {
        this.editor.requestInsertText(block);
      }
    } catch (error) {
      this.editor.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}
