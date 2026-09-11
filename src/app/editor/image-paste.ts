import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imageExtension } from '../../../shared/asset-name';
import { noteRelativeLink } from '../../../shared/note-link';
import { substitutePlaceholders } from '../../../shared/placeholders';
import { textExtension } from '../../../shared/text-extension';
import { formatDate, formatDateTime, formatTime } from '../../../shared/timestamp';
import { stripFrontmatter } from './markdown-frontmatter';

/**
 * Paste / drop into the editor (ADR-0024, ADR-0027, ADR-0028). One
 * CodeMirror extension, mounted on every surface that sets
 * `imageCapture` -- the full-page editor and the "Add entry" drawer.
 * Handles:
 *
 * - an **image file** (paste, OS drag) -> bytes saved into the vault's
 *   per-note `attachments/`, `![](attachments/…)` inserted;
 * - a **vault file** dragged from the Files panel
 *   (`application/x-drey-vault-path`) -> an image is linked in place
 *   (`![](../relative/path)`, no copy), a text file's contents are
 *   inserted raw;
 * - a **web image** dragged from a browser -> downloaded via `saveFromUrl`
 *   and inserted with a visible `[Source](<url>)` line beneath it.
 *
 * A save that has to await shows a `![](uploading:<id>)` placeholder that
 * is swapped for the real link (or rolled back on failure) by a plain
 * text match.
 */
export interface ImagePasteConfig {
  /** Persists raw bytes; resolves to the path for `![](...)`. Rejects with a user message. */
  save: (bytes: Uint8Array, ext: string) => Promise<string>;
  /** The open document's vault-relative path, for `noteRelativeLink`. */
  notePath?: () => string | null;
  /** Reads a vault file's text (Files-panel drag of a text file). */
  readTextFile?: (vaultPath: string) => Promise<string>;
  /** Downloads a web image into the vault; resolves to the path for `![](...)`. */
  saveFromUrl?: (url: string) => Promise<string>;
  /**
   * Decodes a dropped `.ics` / `.msg` calendar invite into a
   * ready-to-insert Markdown meeting section (ADR-0041). Rejects with a
   * user-facing message.
   */
  decodeMeeting?: (bytes: Uint8Array, filename: string) => Promise<string>;
  /**
   * Plugin drop decoders (ADR-0044 stage 2): `dropClaimed` is a SYNCHRONOUS
   * check (a decoder's `match()`) so an unclaimed drop still reaches the
   * base cascade below; `decodeDropped` runs the claiming decoder and
   * resolves the Markdown to insert at the pointer. Rejects with a
   * user-facing message.
   */
  dropClaimed?: (data: DataTransfer) => boolean;
  decodeDropped?: (data: DataTransfer) => Promise<string>;
  /** Shown to the user when a save / read fails, or a file is too large. */
  onError?: (message: string) => void;
}

/** The DataTransfer type the Files panel sets on `dragstart`. */
export const VAULT_PATH_DT_TYPE = 'application/x-drey-vault-path';

/** Calendar-invite extensions decoded into a meeting section on drop (ADR-0041). */
const MEETING_EXTENSIONS = new Set(['ics', 'msg']);

/** True for a `.ics` / `.msg` file name (case-insensitive). */
function isMeetingName(name: string | undefined): boolean {
  const dot = (name ?? '').lastIndexOf('.');
  return dot !== -1 && MEETING_EXTENSIONS.has(name!.slice(dot + 1).toLowerCase());
}

/** The first `.ics` / `.msg` file carried by a drag `DataTransfer`, if any. */
function meetingFile(data: DataTransfer | null): File | undefined {
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (file && isMeetingName(file.name)) {
      return file;
    }
  }
  for (const file of Array.from(data?.files ?? [])) {
    if (isMeetingName(file.name)) {
      return file;
    }
  }
  return undefined;
}

/**
 * The DataTransfer type a Templates-panel row sets on `dragstart` -- a
 * vault-relative `.md` path. Unlike a plain Files-panel drag, the body is
 * inserted with its YAML frontmatter stripped and `{{date}}`/`{{time}}`/
 * `{{datetime}}`/`{{title}}` substituted (ADR-0029).
 */
export const TEMPLATE_DT_TYPE = 'application/x-drey-template';

/** Largest text file whose contents we inline on drop (case D). */
export const TEXT_DROP_MAX = 2 * 1024 * 1024;

/**
 * True for a dropped/pasted file that is an image -- by MIME (the fast
 * path) or, when the OS left `type` blank (common for a Windows Explorer
 * drag), by a recognised image extension on the name.
 */
function isImageFile(type: string, name: string | undefined): boolean {
  return type.startsWith('image/') || !!imageExtension(name ?? '');
}

/** Image files carried by a clipboard or drag `DataTransfer`. */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (file && isImageFile(item.type, file.name)) {
      out.push(file);
    }
  }
  // Some drops expose `files` but not `items`.
  if (out.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (isImageFile(file.type, file.name)) {
        out.push(file);
      }
    }
  }
  return out;
}

/** Session-unique placeholder id -- no crypto needed, just find/replace-safe. */
let placeholderSeq = 0;

/**
 * The change + resulting caret for inserting `text` on its own line at
 * `at` -- a leading newline unless already at line start, a trailing one
 * always, caret parked on the line after. Keeps a rendered image from
 * fusing to a heading and stops Live Preview revealing the raw link the
 * caret would otherwise touch.
 */
function ownLineInsert(
  view: EditorView,
  at: number,
  text: string,
): { from: number; insert: string; anchor: number } {
  const atLineStart = view.state.doc.lineAt(at).from === at;
  const insert = `${atLineStart ? '' : '\n'}${text}\n`;
  return { from: at, insert, anchor: at + insert.length };
}

/**
 * Like `ownLineInsert` but pads a blank line on both sides -- for a large
 * multi-line block (the meeting section, ADR-0041) that should not fuse to
 * the paragraph above or below it.
 */
function sectionInsert(
  view: EditorView,
  at: number,
  text: string,
): { from: number; insert: string; anchor: number } {
  const line = view.state.doc.lineAt(at);
  const atLineStart = line.from === at;
  const prevBlank = !atLineStart || line.number === 1 || view.state.doc.line(line.number - 1).length === 0;
  const lead = atLineStart ? (prevBlank ? '' : '\n') : '\n\n';
  const insert = `${lead}${text}\n`;
  return { from: at, insert, anchor: at + insert.length };
}

/**
 * Inserts a `![](uploading:<id>)` placeholder on its own line at the
 * caret and returns the token + whether a leading newline was added
 * (needed to roll the whole thing back on failure). Synchronous.
 */
function insertPlaceholder(view: EditorView): { token: string; atLineStart: boolean } {
  const token = `![](uploading:${Date.now().toString(36)}-${(placeholderSeq++).toString(36)})`;
  const at = view.state.selection.main.from;
  const atLineStart = view.state.doc.lineAt(at).from === at;
  const { from, insert, anchor } = ownLineInsert(view, at, token);
  view.dispatch({ changes: { from, insert }, selection: { anchor } });
  return { token, atLineStart };
}

/** Swaps a placeholder for `replacement`, or rolls it (and its newlines) back out. */
function settlePlaceholder(
  view: EditorView,
  handle: { token: string; atLineStart: boolean },
  replacement: string,
): void {
  const idx = view.state.doc.toString().indexOf(handle.token);
  if (idx === -1) {
    return; // the user deleted the placeholder while we waited
  }
  if (replacement === '') {
    const from = Math.max(0, idx - (handle.atLineStart ? 0 : 1));
    const to = Math.min(idx + handle.token.length + 1, view.state.doc.length);
    view.dispatch({ changes: { from, to, insert: '' } });
  } else {
    view.dispatch({ changes: { from: idx, to: idx + handle.token.length, insert: replacement } });
  }
}

/** Placeholder -> `await produce()` -> settle; `onError` + rollback on rejection. */
async function resolveInserted(
  view: EditorView,
  produce: () => Promise<string>,
  config: ImagePasteConfig,
): Promise<void> {
  const handle = insertPlaceholder(view);
  let replacement: string;
  try {
    replacement = await produce();
  } catch (error) {
    config.onError?.(error instanceof Error ? error.message : String(error));
    replacement = '';
  }
  settlePlaceholder(view, handle, replacement);
}

/** An image file (paste / OS drag): save the bytes, insert `![](attachments/…)`. */
async function insertImage(view: EditorView, file: File, config: ImagePasteConfig): Promise<void> {
  const ext = imageExtension(file.type || file.name || '');
  if (!ext) {
    return;
  }
  await resolveInserted(
    view,
    async () => `![](${await config.save(new Uint8Array(await file.arrayBuffer()), ext)})`,
    config,
  );
}

/** A vault image dragged from the Files panel: link it in place, no copy. Synchronous. */
function insertRelativeLink(view: EditorView, vaultPath: string, config: ImagePasteConfig): void {
  const rel = noteRelativeLink(config.notePath?.() ?? '', vaultPath);
  const link = /[ ()]/.test(rel) ? `![](<${rel}>)` : `![](${rel})`;
  const at = view.state.selection.main.from;
  const { from, insert, anchor } = ownLineInsert(view, at, link);
  view.dispatch({ changes: { from, insert }, selection: { anchor } });
}

/**
 * The image URL a browser drag carries: the first real entry of
 * `text/uri-list`, else an `<img src>` in `text/html`, else `text/plain`.
 * Returns `''` unless it is an `http(s)` URL that is plausibly an image
 * (an `<img>` was in the html, or the path has an image extension) -- so a
 * plain dragged hyperlink is left alone, not downloaded.
 */
function imageUrlFromTransfer(data: DataTransfer | null): string {
  if (!data) {
    return '';
  }
  const html = data.getData('text/html');
  const fromList =
    data
      .getData('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) ?? '';
  let url = fromList;
  if (!url && html) {
    url =
      new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src')
        ?.trim() ?? '';
  }
  if (!url) {
    url = data.getData('text/plain').trim();
  }
  if (!/^https?:\/\//i.test(url)) {
    return '';
  }
  let looksImage = /<img\b/i.test(html);
  if (!looksImage) {
    try {
      looksImage = !!imageExtension(new URL(url).pathname);
    } catch {
      return '';
    }
  }
  return looksImage ? url : '';
}

/** A web image dragged from a browser: download it, insert `![](…)` + a `[Source](<url>)` line. */
async function insertFromUrl(
  view: EditorView,
  url: string,
  config: ImagePasteConfig,
): Promise<void> {
  await resolveInserted(
    view,
    async () => `![](${await config.saveFromUrl!(url)})\n[Source](<${url}>)`,
    config,
  );
}

/** `{{date}}`/`{{time}}`/`{{datetime}}`/`{{title}}` for a template dropped now. */
function templatePlaceholders(config: ImagePasteConfig): Record<string, string> {
  const now = new Date();
  const note = config.notePath?.() ?? null;
  const title = note ? (note.split('/').pop() ?? '').replace(/\.md$/i, '') : '';
  return {
    date: formatDate(now),
    time: formatTime(now),
    datetime: formatDateTime(now),
    title,
  };
}

/** A text file (Files panel or OS drag): its contents, raw, at the drop point. */
function insertText(view: EditorView, text: string, config: ImagePasteConfig): void {
  if (text.length > TEXT_DROP_MAX) {
    config.onError?.('That file is too large to drop in (over 2 MB).');
    return;
  }
  const at = view.state.selection.main.from;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
}

export function imagePaste(config: ImagePasteConfig): Extension {
  const wantsDrop = (data: DataTransfer | null): boolean => {
    const types = Array.from(data?.types ?? []);
    return ['Files', VAULT_PATH_DT_TYPE, TEMPLATE_DT_TYPE, 'text/uri-list', 'text/html'].some((t) =>
      types.includes(t),
    );
  };

  return EditorView.domEventHandlers({
    dragover(event, view) {
      if (!view.state.readOnly && wantsDrop(event.dataTransfer)) {
        event.preventDefault(); // required for `drop` to fire
      }
      return false;
    },
    drop(event, view) {
      if (view.state.readOnly) {
        return false;
      }
      const data = event.dataTransfer;

      // Plugin drop decoders (ADR-0044 stage 2) claim a drop BEFORE the
      // base cascade. The claim check is synchronous (a decoder's
      // `match()`), so an unclaimed drop still reaches the base handling;
      // only a claimed one is prevented and decoded async.
      if (data && config.dropClaimed?.(data)) {
        event.preventDefault();
        const dropAt =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.from;
        view.dispatch({ selection: { anchor: dropAt } });
        const decode = config.decodeDropped;
        if (!decode) {
          return false;
        }
        void decode(data)
          .then((decoded) => {
            const pos = view.state.selection.main.from;
            const { from, insert, anchor } = sectionInsert(view, pos, decoded);
            view.dispatch({ changes: { from, insert }, selection: { anchor }, scrollIntoView: true });
          })
          .catch((error: unknown) =>
            config.onError?.(error instanceof Error ? error.message : String(error)),
          );
        return true;
      }

      // A template dragged from the Templates panel: read it, strip the
      // frontmatter, substitute placeholders, drop the body at the pointer.
      const templatePath = data?.getData(TEMPLATE_DT_TYPE) ?? '';
      if (templatePath && config.readTextFile) {
        event.preventDefault();
        const dropAt =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.from;
        view.dispatch({ selection: { anchor: dropAt } });
        const read = config.readTextFile;
        void read(templatePath)
          .then((raw) =>
            insertText(
              view,
              substitutePlaceholders(stripFrontmatter(raw), templatePlaceholders(config)),
              config,
            ),
          )
          .catch((error: unknown) =>
            config.onError?.(error instanceof Error ? error.message : String(error)),
          );
        return true;
      }

      // A calendar invite (`.ics` / `.msg`) dragged from Outlook or the file
      // system: decode it in the main process and drop the meeting section
      // at the pointer (ADR-0041). Sub-second, so no upload placeholder.
      const invite = config.decodeMeeting ? meetingFile(data) : undefined;
      if (invite) {
        event.preventDefault();
        const dropAt =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.from;
        view.dispatch({ selection: { anchor: dropAt } });
        const decode = config.decodeMeeting!;
        void invite
          .arrayBuffer()
          .then((buffer) => decode(new Uint8Array(buffer), invite.name))
          .then((block) => {
            const pos = view.state.selection.main.from;
            const { from, insert, anchor } = sectionInsert(view, pos, block);
            view.dispatch({ changes: { from, insert }, selection: { anchor }, scrollIntoView: true });
          })
          .catch((error: unknown) =>
            config.onError?.(error instanceof Error ? error.message : String(error)),
          );
        return true;
      }

      const files = imageFiles(data);
      const hasAnyFile = (data?.files.length ?? 0) > 0;
      const textFile = files.length
        ? undefined
        : Array.from(data?.files ?? []).find((f) => textExtension(f.name));
      const vaultPath = files.length || textFile ? '' : (data?.getData(VAULT_PATH_DT_TYPE) ?? '');
      const url =
        files.length || textFile || vaultPath || !config.saveFromUrl
          ? ''
          : imageUrlFromTransfer(data);
      if (files.length === 0 && !hasAnyFile && !vaultPath && !url) {
        return false; // a plain text / URL drag we won't act on -- let CodeMirror handle it
      }
      event.preventDefault();

      const at =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      view.dispatch({ selection: { anchor: at } });

      if (files.length) {
        for (const file of files) {
          void insertImage(view, file, config);
        }
      } else if (textFile) {
        if (textFile.size > TEXT_DROP_MAX) {
          config.onError?.('That file is too large to drop in (over 2 MB).');
        } else {
          void textFile
            .text()
            .then((text) => insertText(view, text, config))
            .catch((error: unknown) =>
              config.onError?.(error instanceof Error ? error.message : String(error)),
            );
        }
      } else if (vaultPath) {
        if (imageExtension(vaultPath)) {
          insertRelativeLink(view, vaultPath, config);
        } else if (textExtension(vaultPath) && config.readTextFile) {
          const read = config.readTextFile;
          void read(vaultPath)
            .then((text) => insertText(view, text, config))
            .catch((error: unknown) =>
              config.onError?.(error instanceof Error ? error.message : String(error)),
            );
        }
      } else if (url) {
        void insertFromUrl(view, url, config);
      }
      // A non-image, non-text file drop falls through here: swallowed
      // (preventDefault'd), nothing inserted.
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
