import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { EmojiPickerService } from './emoji-picker.service';

describe('EmojiPickerService', () => {
  it('open() records the request anchored at the caret; close() drops it', () => {
    const svc = new EmojiPickerService();
    const view = new EditorView({
      state: EditorState.create({ doc: 'hello', selection: { anchor: 5 } }),
      parent: document.body,
    });
    try {
      svc.open({ view, from: 5, to: 5 });
      const req = svc.request();
      expect(req).not.toBeNull();
      expect(req!.view).toBe(view);
      expect(req!.from).toBe(5);
      expect(req!.anchor.x).toBeGreaterThanOrEqual(0);
      expect(req!.anchor.y).toBeGreaterThanOrEqual(0);

      svc.close();
      expect(svc.request()).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it('refuses to open on a read-only surface', () => {
    const svc = new EmojiPickerService();
    const view = new EditorView({
      state: EditorState.create({ doc: 'locked', extensions: [EditorState.readOnly.of(true)] }),
      parent: document.body,
    });
    try {
      svc.open({ view, from: 0, to: 0 });
      expect(svc.request()).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it('insert() replaces the range with :name:, closes and records a recent', () => {
    localStorage.removeItem('drey.emoji.recent');
    const svc = new EmojiPickerService();
    const view = new EditorView({
      state: EditorState.create({ doc: 'mood ', selection: { anchor: 5 } }),
      parent: document.body,
    });
    try {
      svc.open({ view, from: 5, to: 5 });
      svc.insert('joy');
      expect(view.state.doc.toString()).toBe('mood :joy:');
      expect(view.state.selection.main.head).toBe('mood :joy:'.length);
      expect(svc.request()).toBeNull();
      expect(localStorage.getItem('drey.emoji.recent')).toContain('joy');
    } finally {
      view.destroy();
      localStorage.removeItem('drey.emoji.recent');
    }
  });

  it('insert() without an open request is a no-op', () => {
    const svc = new EmojiPickerService();
    expect(() => svc.insert('joy')).not.toThrow();
  });
});
