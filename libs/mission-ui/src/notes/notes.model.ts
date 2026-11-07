/**
 * The Notes clients' types, the seam to the shell and the pure logic
 * (req-101, canvas decision 18). The wire shapes mirror
 * `packages/tickets-engine/src/contracts/notes.ts` (req-100, milestone 174),
 * duplicated locally the way the other screens do; the stable refusal `code`
 * is mapped to a catalog key (`notes.error.<code>`), the English `error` text
 * is never shown.
 */
import { InjectionToken, signal, type Signal } from '@angular/core';
import type { I18n, MessageKey } from '../../../../shared/i18n';
import { shortDayOf } from '../phone/phone';

export type NotesErrorCode =
  | 'read_only'
  | 'exists'
  | 'not_found'
  | 'bad_path'
  | 'bad_request'
  | 'no_vault'
  | 'too_large'
  | 'internal'
  /** Client-only: the desk did not answer. */
  | 'offline';

export interface NotesFailure {
  readonly ok: false;
  readonly code: NotesErrorCode;
  readonly error: string;
}

export interface NoteEntry {
  readonly path: string;
  readonly name: string;
  readonly mtime: number;
  readonly size: number;
}

export interface NoteFolderEntry {
  readonly path: string;
  readonly name: string;
}

export interface NoteSearchLine {
  readonly line: number;
  readonly heading: string;
  readonly text: string;
}

export interface NoteSearchHit extends NoteEntry {
  readonly lines: readonly NoteSearchLine[];
}

export type NotesListReply =
  | {
      readonly ok: true;
      readonly vault: string;
      readonly folder: string;
      readonly folders: readonly NoteFolderEntry[];
      readonly notes: readonly NoteEntry[];
    }
  | NotesFailure;

export type NotesRecentReply =
  | { readonly ok: true; readonly vault: string; readonly notes: readonly NoteEntry[] }
  | NotesFailure;

export type NotesSearchReply =
  | { readonly ok: true; readonly query: string; readonly hits: readonly NoteSearchHit[]; readonly truncated: boolean }
  | NotesFailure;

export type NoteReadReply =
  | {
      readonly ok: true;
      readonly path: string;
      readonly name: string;
      readonly text: string;
      readonly body: string;
      readonly tags: readonly string[];
      readonly mtime: number;
    }
  | NotesFailure;

export interface NoteWritten {
  readonly ok: true;
  readonly path: string;
  readonly text: string;
  readonly mtime: number;
}

/** The note changed on the desk since the client read it: nothing was written. */
export interface NoteConflict {
  readonly ok: false;
  readonly code: 'conflict';
  readonly error: string;
  readonly disk: { readonly text: string; readonly mtime: number };
}

export type NoteSaveReply = NoteWritten | NoteConflict | NotesFailure;
export type NoteCreateReply = NoteWritten | NotesFailure;

/** The calls the Notes screens make; `McClient` implements it over the desk. */
export interface McNotesApi {
  notesList(folder?: string): Promise<NotesListReply>;
  notesRecent(limit?: number): Promise<NotesRecentReply>;
  notesSearch(query: string, limit?: number): Promise<NotesSearchReply>;
  notesRead(path: string): Promise<NoteReadReply>;
  notesSave(path: string, text: string, baseMtime: number): Promise<NoteSaveReply>;
  notesCreate(path: string, text?: string): Promise<NoteCreateReply>;
}

/** What the Notes screens take from the shell besides the calls. */
export interface McNotesHost {
  readonly api: McNotesApi;
  /** A read-only device reads, never writes. */
  readOnly(): boolean;
  /** The SSE `notes` event as a signal: a sequence number and the paths a device wrote. */
  readonly changed: Signal<{ readonly seq: number; readonly paths: readonly string[] }>;
  /** "Ask about this note": the Mission Control chat with the note named in the composer. */
  askAbout(path: string): void;
  openTicket(id: string): void;
  /** The linked ticket card's words (board 10l); absent or null = the id alone. */
  ticketSummary?(id: string): { readonly title: string; readonly phase: string } | null;
  toast(message: string, kind?: 'ok' | 'error'): void;
}

const offline: NotesFailure = { ok: false, code: 'offline', error: 'offline' };

/** A host with no desk behind it (specs that do not bind one, a missing provider). */
export function disconnectedNotesHost(): McNotesHost {
  return {
    api: {
      notesList: async () => offline,
      notesRecent: async () => offline,
      notesSearch: async () => offline,
      notesRead: async () => offline,
      notesSave: async () => offline,
      notesCreate: async () => offline,
    },
    readOnly: () => false,
    changed: signal({ seq: 0, paths: [] as readonly string[] }).asReadonly(),
    askAbout: () => undefined,
    openTicket: () => undefined,
    toast: () => undefined,
  };
}

export const MC_NOTES_HOST = new InjectionToken<McNotesHost>('mc-notes-host', {
  providedIn: 'root',
  factory: disconnectedNotesHost,
});

/** The catalog key of a refusal code. */
export function errorKeyOf(code: string): MessageKey {
  switch (code) {
    case 'read_only':
    case 'exists':
    case 'not_found':
    case 'bad_path':
    case 'bad_request':
    case 'no_vault':
    case 'too_large':
    case 'offline':
      return `notes.error.${code}` as MessageKey;
    default:
      return 'notes.error.internal';
  }
}

/** The ticket a note names in its frontmatter (`ticket: T-0123`), or null. */
export function ticketIdOf(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---' || line.trim() === '...') {
      return null;
    }
    const match = /^ticket:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$/.exec(line);
    if (match !== null) {
      return match[1]!;
    }
  }
  return null;
}

/** The vault-relative path of a new note typed as a name in a folder: `.md` appended, edges trimmed. */
export function newNotePathOf(folder: string, typed: string): string | null {
  const name = typed.trim().replace(/^\/+/, '');
  if (name === '' || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '')) {
    return null;
  }
  const file = /\.md$/i.test(name) ? name : `${name}.md`;
  return folder === '' ? file : `${folder}/${file}`;
}

/** The parent folder of a vault-relative folder path ('' = the root). */
export function parentFolderOf(folder: string): string {
  const at = folder.lastIndexOf('/');
  return at < 0 ? '' : folder.slice(0, at);
}

/** The folder a note path lies in ('' = the root). */
export function folderOfPath(path: string): string {
  return parentFolderOf(path);
}

/** One line of the first search line of a hit: its heading and text, for the row's second line. */
export function hitSnippetOf(hit: NoteSearchHit): string {
  const first = hit.lines[0];
  if (first === undefined) {
    return '';
  }
  return first.heading === '' ? first.text.trim() : `${first.heading} · ${first.text.trim()}`;
}

/** A note's time on the phone (boards 10k, 10l): `today 09:12`, `yesterday`, `Mon`, else the short date. */
export function noteWhenOf(mtime: number, nowMs: number, i18n: Pick<I18n, 't' | 'formatTime' | 'locale'>): string {
  const date = new Date(mtime);
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(nowMs) - day(mtime)) / 86_400_000);
  if (days <= 0) {
    return i18n.t('notes.phone.today_at', { time: i18n.formatTime(date) });
  }
  if (days === 1) {
    return i18n.t('notes.phone.yesterday');
  }
  return shortDayOf(date, days, i18n);
}
