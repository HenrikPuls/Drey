import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';

import { formattingContextMenuRows } from './format-menu-rows';
import { extendedMarkdown } from '../editor/markdown-extensions';
import type { EmojiPickerService } from '../emoji-picker/emoji-picker.service';
import type { EditorContextMenuTarget } from '../../../shared/plugin-api/renderer';

/** Builds a target whose DOM chain maps back to `view` (the shape
 *  `buildMenuTarget` produces for a click inside the editor). */
function targetFor(view: EditorView, docPath: string | null): EditorContextMenuTarget {
  return {
    surface: 'editor',
    docPath,
    target: view.dom,
    lineNumber: 1,
    lineText: view.state.doc.line(1).text,
  };
}

/** A picker stand-in recording the open calls. */
function fakePicker(): { picker: EmojiPickerService; calls: unknown[] } {
  const calls: unknown[] = [];
  const picker = { open: (req: unknown) => calls.push(req) };
  return { picker: picker as unknown as EmojiPickerService, calls };
}

describe('formattingContextMenuRows', () => {
  it('offers the extended-dialect rows plus Emoji… on a Markdown surface', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'hello' }),
      parent: document.body,
    });
    try {
      const { picker } = fakePicker();
      const rows = formattingContextMenuRows(targetFor(view, null), {
        isMarkdown: () => true,
        emoji: picker,
      });
      expect(rows.map((r) => r.label)).toEqual([
        'Highlight',
        'Subscript',
        'Superscript',
        'Inline math',
        'Math block',
        'Callout',
        'Footnote',
        'Clear formatting',
        'Emoji…',
      ]);
      // Every row carries a runnable action.
      expect(rows.every((r) => typeof r.run === 'function')).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it('stays away from non-Markdown documents and image tabs', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'const x = 1;' }),
      parent: document.body,
    });
    try {
      const { picker } = fakePicker();
      const deps = { isMarkdown: (p: string) => p.endsWith('.md'), emoji: picker };
      expect(formattingContextMenuRows(targetFor(view, 'src/app.ts'), deps)).toEqual([]);
      expect(
        formattingContextMenuRows({ surface: 'image', imagePath: 'a.png' }, deps),
      ).toEqual([]);
    } finally {
      view.destroy();
    }
  });

  it('applies a row to the clicked view and focuses it', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'watch out', selection: { anchor: 0, head: 9 } }),
      parent: document.body,
    });
    try {
      const { picker } = fakePicker();
      const rows = formattingContextMenuRows(targetFor(view, 'n.md'), {
        isMarkdown: () => true,
        emoji: picker,
      });
      rows.find((r) => r.label === 'Callout')!.run();
      expect(view.state.doc.toString()).toBe('> [!NOTE]\n> watch out');

      rows.find((r) => r.label === 'Highlight')!.run();
      expect(view.state.doc.toString()).toBe('> [!NOTE]\n> ==watch out==');
      expect(view.hasFocus).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it('hands the selection range to the emoji picker', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'mood ', selection: { anchor: 5 } }),
      parent: document.body,
    });
    try {
      const { picker, calls } = fakePicker();
      const rows = formattingContextMenuRows(targetFor(view, 'n.md'), {
        isMarkdown: () => true,
        emoji: picker,
      });
      rows.find((r) => r.label === 'Emoji…')!.run();
      expect(calls).toHaveLength(1);
      expect((calls[0] as { from: number; to: number; view: EditorView }).view).toBe(view);
      expect((calls[0] as { from: number; to: number }).from).toBe(5);
    } finally {
      view.destroy();
    }
  });

  it('the eraser row peels the outermost inline wrap of the clicked view', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: '**fett ==rot==**',
        selection: { anchor: 9 },
        extensions: [markdown({ base: markdownLanguage, extensions: extendedMarkdown })],
      }),
      parent: document.body,
    });
    try {
      const { picker } = fakePicker();
      const rows = formattingContextMenuRows(targetFor(view, 'n.md'), {
        isMarkdown: () => true,
        emoji: picker,
      });
      rows.find((r) => r.label === 'Clear formatting')!.run();
      expect(view.state.doc.toString()).toBe('fett ==rot==');
    } finally {
      view.destroy();
    }
  });
});
