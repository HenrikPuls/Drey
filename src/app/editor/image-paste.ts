import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imageExtension } from '../../../shared/asset-name';

/**
 * Paste / drop an image into the editor: the bytes are saved into the
 * vault (ADR-0024) and an `![](attachments/…)` link is inserted at the
 * caret (or the drop point). One CodeMirror extension, so every surface
 * that mounts the shared `MarkdownSurface` with `imageCapture` on -- the
 * full-page editor and the "Add entry" drawer -- gets it; the note
 * assistant composer leaves it off.
 *
 * While the save is in flight a `![](uploading:<id>)` placeholder holds
 * the spot, so concurrent typing and multi-image pastes stay correct; it
 * is swapped for the real link (or removed on failure) by a plain text
 * match once the promise settles.
 */
export interface ImagePasteConfig {
  /**
   * Persists the bytes and resolves to the path to put inside `![](...)`
   * -- note-relative, so the existing image resolver picks it up. Rejects
   * when there is no vault / no desktop bridge; the placeholder is then
   * removed and `onError` is called.
   */
  save: (bytes: Uint8Array, ext: string) => Promise<string>;
  /** Shown to the user when a save fails (e.g. no vault open). */
  onError?: (message: string) => void;
}

/** Image files carried by a clipboard or drag `DataTransfer`. */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        out.push(file);
      }
    }
  }
  // Some drops expose `files` but not `items`.
  if (out.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) {
        out.push(file);
      }
    }
  }
  return out;
}

/** Session-unique placeholder id -- no crypto needed, just find/replace-safe. */
let placeholderSeq = 0;

/**
 * Inserts one image at the current selection: a `![](uploading:…)`
 * placeholder on its own line (a leading newline is added when the caret
 * isn't at line start, a trailing one always), with the caret parked on
 * the line after it -- so the rendered image never sits fused to a
 * heading, and Live Preview shows it straight away rather than revealing
 * the raw link the caret would otherwise touch.
 *
 * The placeholder dispatch is synchronous up to the first `await`, so a
 * caller looping over several files just calls this repeatedly -- each run
 * sees the selection the previous one left.
 */
async function insertImage(view: EditorView, file: File, config: ImagePasteConfig): Promise<void> {
  const ext = imageExtension(file.type || file.name || '');
  if (!ext) {
    return;
  }
  const token = `![](uploading:${Date.now().toString(36)}-${(placeholderSeq++).toString(36)})`;
  const at = view.state.selection.main.from;
  const atLineStart = view.state.doc.lineAt(at).from === at;
  const inserted = `${atLineStart ? '' : '\n'}${token}\n`;
  view.dispatch({
    changes: { from: at, insert: inserted },
    selection: { anchor: at + inserted.length },
  });

  let replacement: string;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    replacement = `![](${await config.save(bytes, ext)})`;
  } catch (error) {
    config.onError?.(error instanceof Error ? error.message : String(error));
    replacement = '';
  }

  const idx = view.state.doc.toString().indexOf(token);
  if (idx === -1) {
    return; // the user deleted the placeholder while we waited
  }
  if (replacement === '') {
    // Roll the whole placeholder insertion back out, newlines included.
    const from = Math.max(0, idx - (atLineStart ? 0 : 1));
    const to = Math.min(idx + token.length + 1, view.state.doc.length);
    view.dispatch({ changes: { from, to, insert: '' } });
  } else {
    view.dispatch({ changes: { from: idx, to: idx + token.length, insert: replacement } });
  }
}

export function imagePaste(config: ImagePasteConfig): Extension {
  return EditorView.domEventHandlers({
    dragover(event, view) {
      if (!view.state.readOnly && Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault(); // required for `drop` to fire
      }
      return false;
    },
    drop(event, view) {
      if (view.state.readOnly) {
        return false;
      }
      const files = imageFiles(event.dataTransfer);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      const at =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      view.dispatch({ selection: { anchor: at } });
      for (const file of files) {
        void insertImage(view, file, config);
      }
      return true;
    },
    paste(event, view) {
      if (view.state.readOnly) {
        return false;
      }
      const files = imageFiles(event.clipboardData);
      if (files.length === 0) {
        return false; // let the default text paste happen
      }
      event.preventDefault();
      for (const file of files) {
        void insertImage(view, file, config);
      }
      return true;
    },
  });
}
