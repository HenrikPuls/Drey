import type { EditorViewMode } from '../editor/editor-prefs.service';

/**
 * The tab-identity string for a vault document: `` `${vaultId}::${path}` ``.
 * The vault id (ADR-0051) scopes the namespace, so the same relative path
 * in two vaults is two documents. A vault-less doc (a scratch tab, a
 * registered plugin kind like `browser://1`) uses the bare string as its
 * key -- `:` cannot occur in a minted vault id, in a Windows path segment,
 * and `://` keeps plugin keys away from vault paths, so the key space is
 * collision-free.
 */
export function docKey(vaultId: string | null, path: string): string {
  return vaultId !== null && vaultId !== '' ? `${vaultId}::${path}` : path;
}

/** The vault id inside a tab key: the segment before `::` (null when bare). */
export function vaultIdOfKey(key: string): string | null {
  const sep = key.indexOf('::');
  return sep === -1 ? null : key.slice(0, sep);
}

/** The vault-relative path inside a tab key: everything after `::`, or the bare key itself. */
export function pathOfKey(key: string): string {
  const sep = key.indexOf('::');
  return sep === -1 ? key : key.slice(sep + 2);
}

/**
 * One open document (one tab). `savedContent` is what's on disk (in `\n`
 * form); `bufferContent` is the live editor buffer; the two differing is
 * what makes the tab dirty.
 *
 * `existsOnDisk` is `false` for a **draft** -- a daily note opened from the
 * calendar for a day that has no file yet. A draft's `savedContent` is the
 * substituted template, so an untouched draft is *not* dirty and `save()`
 * skips it: clicking around the calendar never writes empty notes. The
 * first real edit makes it dirty; the first `save()` writes the file and
 * flips `existsOnDisk`.
 */
export interface OpenDoc {
  /**
   * The doc's vault id (ADR-0051). `null` for docs that belong to no
   * vault: a never-located scratch tab, or a registered plugin kind
   * (`browser://<n>`).
   */
  readonly vaultId: string | null;
  /**
   * Vault-relative path, e.g. `daily/2026-09-05.md` -- what every IPC call
   * speaks. What identifies the TAB across panes/sessions is {@link key}.
   * For a `kind: 'browser'` tab this is the synthetic key `browser://<n>`.
   */
  readonly path: string;
  /**
   * Tab identity (see {@link docKey}): every pane / tab-bar / session /
   * drag consumer keys on this. `path` remains the vault-relative path for
   * IPC and display.
   */
  readonly key: string;
  /** For a browser tab this follows the page title as it loads. */
  readonly name: string;
  /**
   * `'text'` (a Markdown/code buffer, the default), `'image'` (a viewer
   * tab for a `.png`/`.jpg`/… file, ADR-0026) and `'pdf'` (a viewer tab
   * for a `.pdf` file over the built-in PDFium viewer, ADR-0052) are the
   * base kinds. Anything else is a registered doc kind (ADR-0044 stage
   * 8A) -- the browser tab (`browser://<n>`, ADR-0042) today, plugin tabs
   * from stage 8B -- resolved through the `DocKindRegistry` by the pane
   * body, the tab strip and the session. The non-text kinds carry no
   * buffer (`savedContent === bufferContent === ''`, never dirty); they
   * skip every text-only path (`save`, `saveAs`, `setViewMode`,
   * `updateBuffer`).
   */
  readonly kind: string;
  savedContent: string;
  bufferContent: string;
  viewMode: EditorViewMode;
  /** Line ending this file uses on disk; the buffer is always held in `\n`. */
  eol: '\n' | '\r\n';
  /** `modifiedMs` from the last read/write -- the save conflict guard sends it back (ADR-0060). */
  modifiedMs: number;
  existsOnDisk: boolean;
  /**
   * The file changed on disk while this tab holds unsaved edits (ADR-0060)
   * -- noticed by the watcher round, shown in the meta bar, settled through
   * `EditorService.resolveDiskChange` or by the next save's own check.
   */
  diskChanged?: boolean;
  /**
   * `true` for a generated scratch doc (the tag-search export) that has no
   * intended location: `save()` routes to `saveAs()` so the user picks one.
   * Daily-note drafts leave this `false` -- they save to their own path. A
   * plugin doc kind tab does not carry this either -- it saves nothing.
   */
  askOnSave?: boolean;
  /**
   * A pinned tab is never the tab another file replaces (milestone 32's
   * clean-tab replacement, see `DocOpenService`): the next file opens in a
   * new tab beside it. Persisted with the session; closing a pinned tab
   * stays an explicit act.
   */
  pinned?: boolean;
  /**
   * An out-of-vault file the OS handed to Drey (Explorer "Open with",
   * ADR-0054). `path` is its ABSOLUTE path (shown in the meta bar, never sent
   * over a vault IPC), `vaultId` is `null`, the key is `external://…`. It is
   * edited like any note and saved IN PLACE through the gated
   * `external:write` channel (no vault pipeline: no frontmatter bump, no
   * index, no hooks); it opens pinned. "Save as…" copies it into a vault.
   */
  external?: boolean;
  /**
   * An in-app help document (the Help menu, ADR-0070): bundled Markdown
   * shown in a read-only pinned tab. `assetBase` is the URL folder
   * (`manual/`) its relative image refs resolve against -- the app origin
   * serves it in dev (`ng serve`) and packaged (`app://`) alike. A help
   * doc is clean by design (buffer === saved, so save and the exit prompt
   * are no-ops), its surface stays non-editable in every view mode, it is
   * never the tab another file replaces, and the session snapshot skips
   * it -- the Help menu reopens it on demand.
   */
  help?: { assetBase: string };
}

export function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] || relativePath;
}

/**
 * Whether `path` is a Markdown document (or a still-unnamed one). Only these
 * get Live Preview and the Markdown-only editor chrome; a `.cpp` / `.json` /
 * `.ts` file opens in source mode with that language's syntax highlighting.
 */
export function isMarkdownPath(path: string): boolean {
  return path === '' || /\.(md|markdown|mdx)$/i.test(path);
}

/** A tab is dirty when its buffer differs from what the disk holds. */
export function isDirty(doc: OpenDoc): boolean {
  return doc.bufferContent !== doc.savedContent;
}

/**
 * Whether opening another file may close this tab instead of adding one
 * beside it: a **clean**, unpinned file-view doc (text, image or pdf), so
 * closing it loses nothing. A registered plugin doc kind (`browser://…`)
 * never qualifies -- its live state is not behind a file, so no re-open
 * would bring it back.
 */
export function isReplaceable(doc: OpenDoc): boolean {
  return (
    doc.pinned !== true &&
    (doc.kind === 'text' || doc.kind === 'image' || doc.kind === 'pdf') &&
    !isDirty(doc)
  );
}

/**
 * File text as the buffer holds it. CodeMirror normalises to `\n`; the
 * file's dominant ending is kept beside it so a CRLF file (the Windows
 * default for these notes) doesn't read back as "modified" the instant the
 * buffer syncs. Restored on save.
 */
export function splitEol(rawContent: string): { text: string; eol: '\n' | '\r\n' } {
  return {
    text: rawContent.replace(/\r\n/g, '\n'),
    eol: rawContent.includes('\r\n') ? '\r\n' : '\n',
  };
}

/**
 * A text tab for `relativePath`. Markdown lands in `markdownMode` -- the
 * mode the user last chose (`⋯` menu), Live Preview by default; a code file
 * always opens in source, since Live Preview only renders Markdown.
 */
export function textDoc(
  relativePath: string,
  vaultId: string | null,
  rawContent: string,
  modifiedMs: number,
  existsOnDisk: boolean,
  markdownMode: EditorViewMode,
  askOnSave = false,
): OpenDoc {
  const { text, eol } = splitEol(rawContent);
  return {
    vaultId,
    path: relativePath,
    key: docKey(vaultId, relativePath),
    name: baseName(relativePath),
    kind: 'text',
    savedContent: text,
    bufferContent: text,
    viewMode: isMarkdownPath(relativePath) ? markdownMode : 'source',
    eol,
    modifiedMs,
    existsOnDisk,
    askOnSave,
  };
}

function bufferless(
  kind: string,
  vaultId: string | null,
  path: string,
  key: string,
  name: string,
): OpenDoc {
  return {
    vaultId,
    path,
    key,
    name,
    kind,
    savedContent: '',
    bufferContent: '',
    viewMode: 'live',
    eol: '\n',
    modifiedMs: 0,
    existsOnDisk: true,
  };
}

/**
 * An image (ADR-0026) or PDF (ADR-0052) viewer tab: the file is never read
 * as text, there is no buffer and the tab is never dirty. The viewer
 * component loads the file itself through `drey-asset://`, from the
 * vault-relative path and the vault id.
 */
export function viewerDoc(
  kind: 'image' | 'pdf',
  relativePath: string,
  vaultId: string | null,
): OpenDoc {
  return bufferless(kind, vaultId, relativePath, docKey(vaultId, relativePath), baseName(relativePath));
}

/** A tab of a registered doc kind (`DocKindRegistry`): the owner mints the key; no buffer, never saved. */
export function pluginDoc(kind: string, key: string, name: string): OpenDoc {
  return bufferless(kind, null, key, key, name);
}

/** A read-only, pinned in-app help tab (see {@link OpenDoc.help}). `content` is already in `\n` form. */
export function helpDoc(path: string, name: string, content: string, assetBase: string): OpenDoc {
  return {
    vaultId: null,
    path,
    key: path,
    name,
    kind: 'text',
    savedContent: content,
    bufferContent: content,
    viewMode: 'view',
    eol: '\n',
    modifiedMs: 0,
    existsOnDisk: true,
    help: { assetBase },
    pinned: true,
  };
}

/** `doc` re-pointed at `nextKey` after a rename or move: buffer and flags stay, identity follows the key. */
export function retargeted(doc: OpenDoc, nextKey: string): OpenDoc {
  const path = pathOfKey(nextKey);
  return { ...doc, key: nextKey, vaultId: vaultIdOfKey(nextKey), path, name: baseName(path) };
}
