import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { formattingStripView } from './format-strip-target';
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

function withView(extensions: readonly unknown[], run: (view: EditorView) => void): void {
  const view = new EditorView({
    state: EditorState.create({ doc: 'hello', extensions: extensions as never }),
    parent: document.body,
  });
  try {
    run(view);
  } finally {
    view.destroy();
  }
}

describe('formattingStripView', () => {
  const md = { isMarkdown: (p: string) => p.endsWith('.md') };

  it('resolves the clicked view on a Markdown pane document', () => {
    withView([], (view) => {
      expect(formattingStripView(targetFor(view, 'notes/a.md'), md)).toBe(view);
    });
  });

  it('resolves the view on a surface without a document (drawer, composer)', () => {
    withView([], (view) => {
      expect(formattingStripView(targetFor(view, null), md)).toBe(view);
    });
  });

  it('stays away from non-Markdown documents, image tabs and a closed menu', () => {
    withView([], (view) => {
      expect(formattingStripView(targetFor(view, 'src/app.ts'), md)).toBeNull();
      expect(formattingStripView({ surface: 'image', imagePath: 'a.png' }, md)).toBeNull();
      expect(formattingStripView(null, md)).toBeNull();
    });
  });

  it('offers nothing on a read-only view (View mode, help documents)', () => {
    withView([EditorState.readOnly.of(true)], (view) => {
      expect(formattingStripView(targetFor(view, 'notes/a.md'), md)).toBeNull();
    });
  });
});
