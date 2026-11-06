import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { MdMode } from '../markdown/mode';
import { McI18n } from '../i18n/i18n.service';
import {
  MC_NOTES_HOST,
  errorKeyOf,
  newNotePathOf,
  parentFolderOf,
  ticketIdOf,
  type NoteEntry,
  type NoteFolderEntry,
  type NoteSearchHit,
} from './notes.model';

/** The pause after the last keystroke before the search runs. */
export const SEARCH_DEBOUNCE_MS = 250;

/** What the discard sheet is about to do once the owner confirms. */
export type DiscardAsk = { readonly kind: 'cancel' } | { readonly kind: 'leave'; readonly then: string | null };

/**
 * The state of the Notes screens (req-101): the list over `/api/notes`,
 * `/recent` and `/search`, and the one open note with its View / edit cycle.
 * One instance serves the phone's two screens and the iPad's two panes. The
 * logic lives here; `mc-notes` and `mc-note` only bind it.
 *
 * Saving sends the text that was read plus its `mtime` as `baseMtime`; a
 * `conflict` reply keeps the owner's draft and offers the disk text next to
 * it (a merge view is a follow-up), a success adopts the text the desk
 * returns (`updated:` may have moved) and leaves editing. Cancel asks only
 * when the draft differs from what was read.
 */
@Injectable({ providedIn: 'root' })
export class NotesStore {
  private readonly host = inject(MC_NOTES_HOST);
  private readonly i18n = inject(McI18n);

  // --- the list -----------------------------------------------------------------
  readonly vault = signal('');
  readonly folder = signal('');
  readonly folders = signal<readonly NoteFolderEntry[]>([]);
  readonly notes = signal<readonly NoteEntry[]>([]);
  readonly recent = signal<readonly NoteEntry[]>([]);
  readonly listError = signal<string | null>(null);
  readonly listLoading = signal(false);

  readonly query = signal('');
  readonly hits = signal<readonly NoteSearchHit[]>([]);
  readonly truncated = signal(false);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  /** The query the shown hits answer; `''` while the list shows. */
  readonly searched = signal('');

  // --- the open note ------------------------------------------------------------
  readonly path = signal<string | null>(null);
  readonly name = signal('');
  /** The text as read or as the desk last returned it. */
  readonly base = signal('');
  readonly mtime = signal(0);
  readonly tags = signal<readonly string[]>([]);
  readonly draft = signal('');
  readonly editing = signal(false);
  readonly mode = signal<MdMode>('view');
  readonly noteLoading = signal(false);
  readonly noteError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  /** The disk state a save collided with; null = no conflict pending. */
  readonly conflict = signal<{ readonly text: string; readonly mtime: number } | null>(null);
  /** The discard sheet's pending action; null = none. */
  readonly discardAsk = signal<DiscardAsk | null>(null);

  readonly readOnly = computed(() => this.host.readOnly());
  readonly dirty = computed(() => this.editing() && this.draft() !== this.base());
  readonly ticketId = computed(() => ticketIdOf(this.base()));

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  private noteSeq = 0;
  private lastSeen = 0;

  constructor() {
    effect(() => {
      const change = this.host.changed();
      if (change.seq !== this.lastSeen) {
        this.lastSeen = change.seq;
        untracked(() => void this.onChanged(change.paths));
      }
    });
  }

  private failure(code: string): string {
    return this.i18n.t(errorKeyOf(code));
  }

  // --- the list ------------------------------------------------------------------

  /** The first screen: the root folder and the recent notes. */
  async loadHome(): Promise<void> {
    await Promise.all([this.openFolder(this.folder()), this.loadRecent()]);
  }

  async openFolder(folder: string): Promise<void> {
    this.listLoading.set(true);
    const reply = await this.host.api.notesList(folder);
    this.listLoading.set(false);
    if (!reply.ok) {
      this.listError.set(this.failure(reply.code));
      return;
    }
    this.listError.set(null);
    this.vault.set(reply.vault);
    this.folder.set(reply.folder);
    this.folders.set(reply.folders);
    this.notes.set(reply.notes);
  }

  async upFolder(): Promise<void> {
    await this.openFolder(parentFolderOf(this.folder()));
  }

  async loadRecent(): Promise<void> {
    const reply = await this.host.api.notesRecent(8);
    if (reply.ok) {
      this.vault.set(reply.vault);
      this.recent.set(reply.notes);
    }
  }

  /** Types into the search field: the search runs after a short pause; an empty field returns to the list. */
  setQuery(text: string): void {
    this.query.set(text);
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (text.trim() === '') {
      this.searchSeq++;
      this.searched.set('');
      this.hits.set([]);
      this.searchError.set(null);
      this.searching.set(false);
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.searchNow();
    }, SEARCH_DEBOUNCE_MS);
  }

  async searchNow(): Promise<void> {
    const query = this.query().trim();
    if (query === '') {
      return;
    }
    const seq = ++this.searchSeq;
    this.searching.set(true);
    const reply = await this.host.api.notesSearch(query);
    if (seq !== this.searchSeq) {
      return;
    }
    this.searching.set(false);
    if (!reply.ok) {
      this.searchError.set(this.failure(reply.code));
      return;
    }
    this.searchError.set(null);
    this.searched.set(query);
    this.hits.set(reply.hits);
    this.truncated.set(reply.truncated);
  }

  // --- the open note ---------------------------------------------------------------

  /**
   * Opens a note in View mode. While an edit has unsaved changes nothing
   * opens: the discard sheet asks first and the confirmation opens it.
   */
  async open(path: string): Promise<void> {
    if (this.dirty()) {
      this.discardAsk.set({ kind: 'leave', then: path });
      return;
    }
    await this.load(path, true);
  }

  private async load(path: string, fresh: boolean): Promise<void> {
    const seq = ++this.noteSeq;
    if (fresh) {
      this.path.set(path);
      this.resetNote();
    }
    this.noteLoading.set(true);
    const reply = await this.host.api.notesRead(path);
    if (seq !== this.noteSeq) {
      return;
    }
    this.noteLoading.set(false);
    if (!reply.ok) {
      this.noteError.set(this.failure(reply.code));
      return;
    }
    this.noteError.set(null);
    this.path.set(reply.path);
    this.name.set(reply.name);
    this.base.set(reply.text);
    this.draft.set(reply.text);
    this.mtime.set(reply.mtime);
    this.tags.set(reply.tags);
  }

  private resetNote(): void {
    this.name.set('');
    this.base.set('');
    this.draft.set('');
    this.mtime.set(0);
    this.tags.set([]);
    this.editing.set(false);
    this.mode.set('view');
    this.noteError.set(null);
    this.saveError.set(null);
    this.conflict.set(null);
    this.discardAsk.set(null);
  }

  /** Reads the open note again (the Reload of an error). */
  async reload(): Promise<void> {
    const path = this.path();
    if (path !== null) {
      await this.load(path, false);
    }
  }

  /** Back from the note (the phone's labelled back control); asks when there is something to lose. */
  leave(): void {
    if (this.dirty()) {
      this.discardAsk.set({ kind: 'leave', then: null });
      return;
    }
    this.closeNote();
  }

  private closeNote(): void {
    this.noteSeq++;
    this.path.set(null);
    this.resetNote();
  }

  // --- the edit cycle -----------------------------------------------------------------

  /** The pencil (Live Preview) or a Live / Source pick in View: editing starts. */
  startEdit(mode: Exclude<MdMode, 'view'> = 'live'): void {
    if (this.readOnly() || this.path() === null || this.noteLoading() || this.noteError() !== null) {
      return;
    }
    this.editing.set(true);
    this.mode.set(mode);
  }

  /** The segmented control: View shows the draft read-only; Live and Source edit it (starting the edit from View). */
  pickMode(mode: MdMode): void {
    if (mode === 'view') {
      this.mode.set('view');
      return;
    }
    if (this.editing()) {
      this.mode.set(mode);
    } else {
      this.startEdit(mode);
    }
  }

  setDraft(text: string): void {
    if (this.editing()) {
      this.draft.set(text);
    }
  }

  /** X: leaves editing at once when nothing changed, otherwise asks. */
  cancel(): void {
    if (this.dirty()) {
      this.discardAsk.set({ kind: 'cancel' });
      return;
    }
    this.stopEdit();
  }

  private stopEdit(): void {
    this.draft.set(this.base());
    this.editing.set(false);
    this.mode.set('view');
    this.saveError.set(null);
    this.conflict.set(null);
  }

  keepEditing(): void {
    this.discardAsk.set(null);
  }

  async confirmDiscard(): Promise<void> {
    const ask = this.discardAsk();
    this.discardAsk.set(null);
    if (ask === null) {
      return;
    }
    this.stopEdit();
    if (ask.kind === 'leave') {
      if (ask.then === null) {
        this.closeNote();
      } else {
        await this.load(ask.then, true);
      }
    }
  }

  /** ✓: saves the draft against the text that was read. */
  async save(): Promise<void> {
    await this.write(this.mtime());
  }

  private async write(baseMtime: number): Promise<void> {
    const path = this.path();
    if (path === null || !this.editing() || this.saving() || this.readOnly()) {
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    const reply = await this.host.api.notesSave(path, this.draft(), baseMtime);
    this.saving.set(false);
    if (reply.ok) {
      this.base.set(reply.text);
      this.draft.set(reply.text);
      this.mtime.set(reply.mtime);
      this.editing.set(false);
      this.mode.set('view');
      this.conflict.set(null);
      this.host.toast(this.i18n.t('notes.saved'), 'ok');
      void this.refreshAfterWrite();
      return;
    }
    if (reply.code === 'conflict') {
      this.conflict.set({ text: reply.disk.text, mtime: reply.disk.mtime });
      return;
    }
    this.saveError.set(this.failure(reply.code));
  }

  /** The tags may have changed with the text: read the note and the lists again. */
  private async refreshAfterWrite(): Promise<void> {
    const path = this.path();
    if (path !== null && !this.editing()) {
      const reply = await this.host.api.notesRead(path);
      if (reply.ok && this.path() === reply.path && !this.editing()) {
        this.tags.set(reply.tags);
        this.base.set(reply.text);
        this.draft.set(reply.text);
        this.mtime.set(reply.mtime);
      }
    }
    await Promise.all([this.openFolder(this.folder()), this.loadRecent()]);
  }

  /** The owner keeps their draft: it is saved over the disk text just shown. */
  async keepMine(): Promise<void> {
    const conflict = this.conflict();
    if (conflict !== null) {
      await this.write(conflict.mtime);
    }
  }

  /** The owner keeps the desk's text: the draft is dropped and the note shows what is on disk. */
  keepTheirs(): void {
    const conflict = this.conflict();
    if (conflict === null) {
      return;
    }
    this.base.set(conflict.text);
    this.draft.set(conflict.text);
    this.mtime.set(conflict.mtime);
    this.stopEdit();
    void this.reload();
  }

  // --- a new note ---------------------------------------------------------------------

  /** Creates a note named by the owner in the open folder and opens it ready to write; returns the refusal text, or null. */
  async create(typed: string): Promise<string | null> {
    if (this.readOnly()) {
      return this.failure('read_only');
    }
    const path = newNotePathOf(this.folder(), typed);
    if (path === null) {
      return this.failure('bad_path');
    }
    const reply = await this.host.api.notesCreate(path, '');
    if (!reply.ok) {
      return this.failure(reply.code);
    }
    await Promise.all([this.openFolder(this.folder()), this.loadRecent()]);
    await this.load(reply.path, true);
    this.startEdit('live');
    return null;
  }

  // --- the desk's own news ----------------------------------------------------------------

  /** The SSE `notes` event: the lists refresh; the open note reloads unless the owner holds changes. */
  private async onChanged(paths: readonly string[]): Promise<void> {
    await Promise.all([this.openFolder(this.folder()), this.loadRecent()]);
    if (this.query().trim() !== '') {
      await this.searchNow();
    }
    const open = this.path();
    if (open !== null && paths.includes(open) && !this.dirty() && !this.saving()) {
      await this.load(open, false);
    }
  }

  // --- the shell's seams ---------------------------------------------------------------

  askAbout(): void {
    const path = this.path();
    if (path !== null) {
      this.host.askAbout(path);
    }
  }

  openTicket(): void {
    const id = this.ticketId();
    if (id !== null) {
      this.host.openTicket(id);
    }
  }
}
