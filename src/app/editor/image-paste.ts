import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { imageExtension, pdfExtension } from '../../../shared/asset-name';
import { externalDocumentExtension, localFileHref } from '../../../shared/external-document';
import { noteRelativeLink } from '../../../shared/note-link';
import { textExtension } from '../../../shared/text-extension';

/**
 * Paste / drop into the editor (ADR-0024, ADR-0027, ADR-0028). One
 * CodeMirror extension, mounted on every surface that sets
 * `imageCapture` -- the full-page editor and the "Add entry" drawer.
 * Handles:
 *
 * - an **image file** (paste, OS drag) -> bytes saved into the vault's
 *   per-note `attachments/`, `![](attachments/…)` inserted;
 * - a **PDF file** (paste, OS drag, ADR-0052) -> staged name-preserving
 *   into `attachments/`, `![name](attachments/…)` inserted -- the embed
 *   renders as an inline PDF viewer (Live Preview) and Ctrl-click / the
 *   Files panel open it as a PDF tab;
 * - a **vault file** dragged from the Files panel
 *   (`application/x-drey-vault-path`) -> an image or PDF is linked in
 *   place (no copy), a text file's contents are inserted raw, an Office
 *   document is linked in place (ADR-0066);
 * - an **Office document** from the OS (ADR-0066): a plain drop stages it
 *   into `attachments/` like any other leftover file; an `Alt`-drop
 *   copies nothing and links the file where it lives (`file:` link);
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
  /**
   * Name-preserving variant (ADR-0052) for PDFs: stores the bytes under a
   * sanitized form of `fileName` in the note's `attachments/`; resolves to
   * the note-relative path for the embed. Rejects with a user message.
   */
  saveNamed?: (bytes: Uint8Array, fileName: string) => Promise<string>;
  /** The open document's vault-relative path, for `noteRelativeLink`. */
  notePath?: () => string | null;
  /** Reads a vault file's text (Files-panel drag of a text file). */
  readTextFile?: (vaultPath: string, vaultId?: string) => Promise<string>;
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
  /**
   * The absolute path of a dropped OS file, `''` when it has none. Enables
   * the `Alt`-drop that links a document where it lives instead of
   * copying it into `attachments/` (ADR-0066).
   */
  pathForFile?: (file: File) => string;
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
 * vault-relative `.md` path (ADR-0029). Since ADR-0044 stage 3 the drop is
 * DECODED by the Templates plugin's drop decoder; the constant stays here
 * because this extension's `dragover` must allow the type for the plugin's
 * handler to ever see the event — it is the shell<->plugin drop protocol.
 */
export const TEMPLATE_DT_TYPE = 'application/x-drey-template';

/** Largest text file whose contents we inline on drop (case D). */
export const TEXT_DROP_MAX = 2 * 1024 * 1024;

/** A leftover OS file bigger than this is refused, not staged (attachments bloat). */
export const ATTACH_DROP_MAX = 100 * 1024 * 1024;

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
 * True for a dropped/pasted file that is a PDF -- by MIME (the fast path)
 * or, when the OS left `type` blank (common for a Windows Explorer drag),
 * by a `.pdf` extension on the name (ADR-0052).
 */
function isPdfFile(type: string, name: string | undefined): boolean {
  return !!pdfExtension(type || (name ?? ''));
}

/** PDF files carried by a clipboard or drag `DataTransfer`. */
function pdfFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (file && isPdfFile(item.type, file.name)) {
      out.push(file);
    }
  }
  // Some drops expose `files` but not `items`.
  if (out.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (isPdfFile(file.type, file.name)) {
        out.push(file);
      }
    }
  }
  return out;
}

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

/**
 * Image files picked through the formatting toolbar's image button: the
 * same save-and-insert path a pasted image takes, one after another.
 */
export async function insertImageFiles(
  view: EditorView,
  files: readonly File[],
  config: ImagePasteConfig,
): Promise<void> {
  for (const file of files) {
    await insertImage(view, file, config);
  }
}

/**
 * A PDF file (paste / OS drag, ADR-0052): staged name-preserving into the
 * note's `attachments/`, inserted as `![name](attachments/…)`. The
 * original name is the alt text -- it becomes the embed's caption and
 * stays the readable label in raw mode.
 */
async function insertPdf(view: EditorView, file: File, config: ImagePasteConfig): Promise<void> {
  const saveNamed = config.saveNamed;
  if (!saveNamed) {
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await resolveInserted(
    view,
    async () => `![${file.name}](${await saveNamed(bytes, file.name)})`,
    config,
  );
}

/**
 * A leftover OS file (nothing earlier in the cascade claimed it — not an
 * image, PDF, text file, meeting invite or vault-panel drag): staged
 * name-preserving into the note's `attachments/` and inserted as a plain
 * Markdown LINK at the drop point. Milestone 31 — this drop used to be
 * swallowed silently.
 */
async function insertAttachedFile(
  view: EditorView,
  file: File,
  config: ImagePasteConfig,
): Promise<void> {
  const saveNamed = config.saveNamed;
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (!saveNamed || ext === '') {
    config.onError?.(`Skipped "${file.name}" — a file without an extension can't be attached.`);
    return;
  }
  await resolveInserted(view, async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = await saveNamed(bytes, file.name);
    const rel = noteRelativeLink(config.notePath?.() ?? '', path);
    return /[ ()]/.test(rel) ? `[${file.name}](<${rel}>)` : `[${file.name}](${rel})`;
  }, config);
}

/** `[label](target)`, the target in `<...>` when it holds a space or a parenthesis. */
function plainLink(label: string, target: string): string {
  const safeLabel = label.replace(/[[\]]/g, '\\$&');
  return /[ ()]/.test(target) ? `[${safeLabel}](<${target}>)` : `[${safeLabel}](${target})`;
}

/** Inserts `text` inline at the caret and parks the caret behind it. */
function insertInline(view: EditorView, text: string): void {
  const at = view.state.selection.main.from;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
}

/**
 * The documents of an `Alt`-drop that can be linked where they live
 * (ADR-0066): files on the document allowlist with a local absolute path.
 * Empty when the drop carries anything else -- the normal cascade then
 * handles all of it.
 */
function linkableDocuments(
  data: DataTransfer | null,
  config: ImagePasteConfig,
): { name: string; href: string }[] {
  const pathFor = config.pathForFile;
  const files = Array.from(data?.files ?? []);
  if (!pathFor || files.length === 0) {
    return [];
  }
  const out: { name: string; href: string }[] = [];
  for (const file of files) {
    const href = externalDocumentExtension(file.name) ? localFileHref(pathFor(file)) : null;
    if (href === null) {
      return [];
    }
    out.push({ name: file.name, href });
  }
  return out;
}

/**
 * A vault image or PDF dragged from the Files panel: link it in place, no
 * copy. Synchronous. `alt` stays empty for images and carries the file
 * name for PDFs (the embed caption, ADR-0052).
 */
function insertRelativeLink(
  view: EditorView,
  vaultPath: string,
  config: ImagePasteConfig,
  alt = '',
): void {
  const rel = noteRelativeLink(config.notePath?.() ?? '', vaultPath);
  const link = /[ ()]/.test(rel) ? `![${alt}](<${rel}>)` : `![${alt}](${rel})`;
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

      // (The template drop moved to the Templates plugin's drop decoder,
      // ADR-0044 stage 3 — the base cascade no longer knows the MIME type.)

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

      // `Alt`-drop of Office documents (ADR-0066): nothing is copied, each
      // is linked where it lives. A plain drop falls through to the
      // leftovers branch below and is staged into attachments/.
      const linked = event.altKey ? linkableDocuments(data, config) : [];
      if (linked.length) {
        event.preventDefault();
        const dropAt =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.from;
        view.dispatch({ selection: { anchor: dropAt } });
        insertInline(view, linked.map((doc) => plainLink(doc.name, doc.href)).join(' '));
        return true;
      }

      const files = imageFiles(data);
      // PDFs only when no image won the drop (ADR-0052; same precedence
      // the text branch below follows).
      const pdfs = files.length ? [] : pdfFiles(data);
      const hasAnyFile = (data?.files.length ?? 0) > 0;
      const textFile =
        files.length || pdfs.length
          ? undefined
          : Array.from(data?.files ?? []).find((f) => textExtension(f.name));
      const tagged =
        files.length || pdfs.length || textFile ? '' : (data?.getData(VAULT_PATH_DT_TYPE) ?? '');
      // The payload is a tab key (`vaultId::relativePath`, ADR-0051) or a
      // bare vault-relative path from an older source; `::` cannot occur in
      // a real path, so the split is unambiguous.
      const sep = tagged.indexOf('::');
      const vaultDrop = tagged
        ? sep > 0
          ? { vaultId: tagged.slice(0, sep), path: tagged.slice(sep + 2) }
          : { vaultId: undefined, path: tagged }
        : null;
      const url =
        files.length || pdfs.length || textFile || vaultDrop || !config.saveFromUrl
          ? ''
          : imageUrlFromTransfer(data);
      if (files.length === 0 && pdfs.length === 0 && !hasAnyFile && !vaultDrop && !url) {
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
      } else if (pdfs.length) {
        for (const file of pdfs) {
          void insertPdf(view, file, config);
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
      } else if (vaultDrop) {
        if (imageExtension(vaultDrop.path)) {
          insertRelativeLink(view, vaultDrop.path, config);
        } else if (pdfExtension(vaultDrop.path)) {
          // Linked in place, no copy; the file name becomes the embed
          // caption (ADR-0052).
          insertRelativeLink(view, vaultDrop.path, config, vaultDrop.path.split('/').pop() ?? '');
        } else if (textExtension(vaultDrop.path) && config.readTextFile) {
          const read = config.readTextFile;
          void read(vaultDrop.path, vaultDrop.vaultId)
            .then((text) => insertText(view, text, config))
            .catch((error: unknown) =>
              config.onError?.(error instanceof Error ? error.message : String(error)),
            );
        } else if (externalDocumentExtension(vaultDrop.path)) {
          // An Office document already in the vault: a plain link, no
          // copy; a click opens it in its own program (ADR-0066).
          insertInline(
            view,
            plainLink(
              vaultDrop.path.split('/').pop() ?? '',
              noteRelativeLink(config.notePath?.() ?? '', vaultDrop.path),
            ),
          );
        }
      } else if (url) {
        void insertFromUrl(view, url, config);
      } else {
        // The leftovers (hasAnyFile is guaranteed here): stage each into
        // attachments/ and link it, instead of swallowing the drop.
        for (const file of Array.from(data?.files ?? [])) {
          if (file.size > ATTACH_DROP_MAX) {
            config.onError?.(`"${file.name}" is too large to attach (over 100 MB).`);
            continue;
          }
          void insertAttachedFile(view, file, config);
        }
      }
      return true;
    },
    paste(event, view) {
      if (view.state.readOnly) {
        return false;
      }
      const files = imageFiles(event.clipboardData);
      const pdfs = files.length ? [] : pdfFiles(event.clipboardData);
      if (files.length === 0 && pdfs.length === 0) {
        return false; // let the default text paste happen
      }
      event.preventDefault();
      for (const file of files) {
        void insertImage(view, file, config);
      }
      for (const file of pdfs) {
        void insertPdf(view, file, config);
      }
      return true;
    },
  });
}
