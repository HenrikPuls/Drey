import { Compartment, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { basicSetup } from 'codemirror';

import { markdownDialect, modeForcesReadOnly, readOnlyExtension, surfaceModeExtensions, type SurfaceMode } from './engine';
import { dreyEditorLook, dreyFallbackStyle, editorStructure, headingTypographyStyle } from './editor-theme';
import { editorIndentation } from './editor-indent';
import { linkActivation } from './link-open';
import { dispatchToolbarAction } from './toolbar-dispatch';
import type { ToolbarAction } from './toolbar-commands';

/**
 * The framework-free Markdown surface (milestone 133): one CodeMirror 6
 * view in a host element, built from the same engine as the desktop
 * editor (`engine.ts` — dialect, Live Preview, View, Source). Mission
 * Control mounts it from a plain Angular wrapper; nothing here knows
 * Angular, Electron or a vault.
 */
export interface MarkdownViewOptions {
  readonly parent: HTMLElement;
  readonly doc: string;
  readonly mode: SurfaceMode;
  /** User input is allowed (Live Preview and Source); View is read-only always. */
  readonly editable: boolean;
  /** The text after each user or programmatic edit that changed it. */
  readonly onChange?: (text: string) => void;
  /** A link was activated (plain click in View, Ctrl/Cmd-click elsewhere). */
  readonly onOpenLink?: (href: string) => void;
  /** Opens a rendered image / diagram full-screen. */
  readonly onOpenImage?: (src: string) => void;
}

export interface MarkdownViewHandle {
  readonly view: EditorView;
  setMode(mode: SurfaceMode): void;
  setEditable(editable: boolean): void;
  /** Replaces the text only where it differs — selection and scroll survive. */
  setDoc(text: string): void;
  getDoc(): string;
  /** One formatting-strip action on the selection. */
  applyAction(action: ToolbarAction): void;
  focus(): void;
  destroy(): void;
}

export function createMarkdownView(options: MarkdownViewOptions): MarkdownViewHandle {
  const modeCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  let mode = options.mode;
  let editable = options.editable;

  const live = {
    // A ticket's images are not served to the client: a candidate list of
    // nothing shows the alt text rather than a broken request.
    resolveImage: (): readonly string[] => [],
    ...(options.onOpenImage ? { onOpenImage: options.onOpenImage, onZoomDiagram: options.onOpenImage } : {}),
  };
  const readOnlyFor = (m: SurfaceMode, e: boolean): Extension => (e && !modeForcesReadOnly(m) ? [] : readOnlyExtension);

  const extensions: Extension[] = [
    syntaxHighlighting(dreyFallbackStyle, { fallback: true }),
    editorIndentation,
    basicSetup,
    markdownDialect(),
    options.onOpenLink ? linkActivation(options.onOpenLink) : [],
    dreyEditorLook,
    editorStructure,
    Prec.high(syntaxHighlighting(headingTypographyStyle)),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.onChange?.(update.state.doc.toString());
      }
    }),
    readOnlyCompartment.of(readOnlyFor(mode, editable)),
    modeCompartment.of(surfaceModeExtensions(mode, live)),
  ];

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.doc, extensions }),
  });

  return {
    view,
    setMode(next) {
      mode = next;
      view.dispatch({
        effects: [
          modeCompartment.reconfigure(surfaceModeExtensions(next, live)),
          readOnlyCompartment.reconfigure(readOnlyFor(next, editable)),
        ],
      });
    },
    setEditable(next) {
      editable = next;
      view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyFor(mode, next)) });
    },
    setDoc(text) {
      const old = view.state.doc.toString();
      if (old === text) {
        return;
      }
      let head = 0;
      const shortest = Math.min(old.length, text.length);
      while (head < shortest && old.charCodeAt(head) === text.charCodeAt(head)) {
        head++;
      }
      let tail = 0;
      while (
        tail < shortest - head &&
        old.charCodeAt(old.length - 1 - tail) === text.charCodeAt(text.length - 1 - tail)
      ) {
        tail++;
      }
      view.dispatch({ changes: { from: head, to: old.length - tail, insert: text.slice(head, text.length - tail) } });
    },
    getDoc: () => view.state.doc.toString(),
    applyAction: (action) => dispatchToolbarAction(view, action),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
