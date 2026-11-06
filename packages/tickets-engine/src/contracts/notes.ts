/**
 * The Notes API's contract (req-100, canvas decision 18): what a paired
 * phone or iPad may do with the notes of the active vault. Every refusal is
 * a stable `code` plus English `error` text, so the client maps the code to
 * its own catalog string and never parses the text.
 *
 * Routes (bearer token on all of them; the two POSTs refuse a read-only device):
 *
 * | Route | Reply |
 * |---|---|
 * | `GET /api/notes?folder=<rel>` | {@link NotesListReply}: one folder, root when absent |
 * | `GET /api/notes/recent?limit=<n>` | {@link NotesRecentReply}: newest mtime first |
 * | `GET /api/notes/search?q=<words>&limit=<n>` | {@link NotesSearchReply} |
 * | `GET /api/notes/note?path=<rel>` | {@link NoteReadReply} |
 * | `POST /api/notes/note` {@link NoteSaveRequest} | {@link NoteSaveReply} |
 * | `POST /api/notes` {@link NoteCreateRequest} | {@link NoteCreateReply} |
 *
 * SSE: `GET /api/events` carries `event: notes` with {@link NotesChangedEvent}.
 */
import type { Frontmatter } from '../../../../shared/ipc-api';

export type NotesErrorCode =
  /** 403: this device is paired read-only. */
  | 'read_only'
  /** 200: the note changed since the client read it; the reply carries the disk state. */
  | 'conflict'
  /** 200: a create hit a note that already exists. */
  | 'exists'
  /** 404: no such note or folder (a save: it was deleted since the client read it). */
  | 'not_found'
  /** 400: the path is malformed, leaves the vault, or lies in a folder the API does not serve. */
  | 'bad_path'
  /** 400: a parameter or the body is missing or of the wrong type. */
  | 'bad_request'
  /** 404: the vault's folder does not exist right now. */
  | 'no_vault'
  /** 413: the body is over the note size limit. */
  | 'too_large'
  /** 500: reading or writing failed on the desk. */
  | 'internal';

export interface NotesFailure {
  readonly ok: false;
  readonly code: Exclude<NotesErrorCode, 'conflict'>;
  readonly error: string;
}

/** A vault-relative path uses `/` and is the note's address in every call. */
export interface NoteEntry {
  readonly path: string;
  /** The file name without `.md`. */
  readonly name: string;
  /** Milliseconds since the epoch, whole. */
  readonly mtime: number;
  readonly size: number;
}

export interface NoteFolderEntry {
  readonly path: string;
  readonly name: string;
}

export type NotesListReply =
  | { readonly ok: true; readonly vault: string; readonly folder: string; readonly folders: readonly NoteFolderEntry[]; readonly notes: readonly NoteEntry[] }
  | NotesFailure;

export type NotesRecentReply = { readonly ok: true; readonly vault: string; readonly notes: readonly NoteEntry[] } | NotesFailure;

export interface NoteSearchLine {
  /** 1-based, counted over the whole file. */
  readonly line: number;
  /** The section's heading; '' before the first one. */
  readonly heading: string;
  readonly text: string;
}

export interface NoteSearchHit extends NoteEntry {
  readonly lines: readonly NoteSearchLine[];
}

export type NotesSearchReply =
  | {
      readonly ok: true;
      readonly query: string;
      /** Newest mtime first. */
      readonly hits: readonly NoteSearchHit[];
      /** The hit limit or the scan bound cut the answer short. */
      readonly truncated: boolean;
    }
  | NotesFailure;

export type NoteReadReply =
  | {
      readonly ok: true;
      readonly path: string;
      readonly name: string;
      /** The whole file, `\n` line ends: what the editor holds and a save sends back. */
      readonly text: string;
      /** The parsed frontmatter; null without a fence or with broken YAML. */
      readonly frontmatter: Frontmatter | null;
      /** `text` after the frontmatter fence. */
      readonly body: string;
      /** The inline `#tag`s of the body, lower-cased, without duplicates. */
      readonly tags: readonly string[];
      /** Sent back as `baseMtime` on a save. */
      readonly mtime: number;
    }
  | NotesFailure;

export interface NoteSaveRequest {
  readonly path: string;
  /** The whole file; line ends are normalized, the file's own are kept on disk. */
  readonly text: string;
  /** The `mtime` of the state this text was edited from. */
  readonly baseMtime: number;
}

export interface NoteCreateRequest {
  /** Vault-relative, ending in `.md`; missing folders are created. */
  readonly path: string;
  readonly text?: string;
}

export interface NoteWritten {
  readonly ok: true;
  readonly path: string;
  /** What is on disk now (a save bumps an existing `updated:`), `\n` line ends. */
  readonly text: string;
  readonly mtime: number;
}

/**
 * The note changed since the client read it: nothing was written. The client
 * merges against `disk` and saves again with `disk.mtime` as `baseMtime`.
 */
export interface NoteConflict {
  readonly ok: false;
  readonly code: 'conflict';
  readonly error: string;
  readonly disk: { readonly text: string; readonly mtime: number };
}

export type NoteSaveReply = NoteWritten | NoteConflict | NotesFailure;
export type NoteCreateReply = NoteWritten | NotesFailure;

/** The SSE `notes` event: which notes a device wrote, so other clients refresh. */
export interface NotesChangedEvent {
  readonly changed: readonly string[];
}

/** What the notes service tells its listeners; `vaultPath` stays on the desk and never reaches a device. */
export interface NotesChange extends NotesChangedEvent {
  readonly vaultPath: string;
}

/** The notes half the router and the gateway call. */
export interface NotesAccess {
  list(folder: unknown): Promise<NotesListReply>;
  recent(limit: number): Promise<NotesRecentReply>;
  search(query: string, limit: number): Promise<NotesSearchReply>;
  read(path: unknown): Promise<NoteReadReply>;
  save(request: NoteSaveRequest, device: string): Promise<NoteSaveReply>;
  create(request: NoteCreateRequest, device: string): Promise<NoteCreateReply>;
  onChanged(listener: (change: NotesChange) => void): () => void;
}

/** The engine config key naming the vault the API serves; the Drey plugin keeps it on the active vault. */
export const NOTES_VAULT_KEY = 'notes.vaultPath';
