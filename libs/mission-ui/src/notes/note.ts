import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { MessageKey } from '../../../../shared/i18n';
import { AppBar } from '../app-bar/app-bar';
import { PhoneIcon, type PhoneIconName } from '../phone/icon';
import { phoneSignal } from '../phone/phone';
import { noteWhenOf } from './notes.model';
import type { ToolbarAction } from '@markdown-surface/toolbar-commands';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { Markdown } from '../markdown/markdown';
import type { MdMode } from '../markdown/mode';
import { NotesStore } from './notes.store';
import { folderOfPath } from './notes.model';

/**
 * One note (req-101, boards 10l, 10p, 10r): opens in **View** of the shared
 * Markdown surface; the pencil (or a Live / Source pick) starts editing in
 * Live Preview with **X** and **✓** as icons — X asks only when the text
 * changed, ✓ saves against the `mtime` that was read. Beneath the text: the
 * tags, the link to the ticket (when the note names one) and "Ask about
 * this note". A read-only device has no pencil. On the phone the labelled
 * back control returns to the list, on the iPad the note is the centre pane.
 */
/** The bar above the keyboard (board 10p): the surface's own actions on the board's icons. */
const PHONE_FORMAT_BUTTONS: readonly { readonly icon: PhoneIconName; readonly label: MessageKey; readonly action: ToolbarAction | null }[] = [
  { icon: 'bold', label: 'notes.phone.bold', action: { kind: 'wrap', marker: '**' } },
  { icon: 'italic', label: 'notes.phone.italic', action: { kind: 'wrap', marker: '*' } },
  { icon: 'heading', label: 'notes.phone.heading', action: { kind: 'heading', level: 1 } },
  { icon: 'list', label: 'notes.phone.list', action: { kind: 'list', style: 'bullet' } },
  { icon: 'checkbox', label: 'notes.phone.checkbox', action: { kind: 'list', style: 'task' } },
  { icon: 'link', label: 'notes.phone.link', action: { kind: 'link' } },
  { icon: 'hash', label: 'notes.phone.tag', action: null },
];

@Component({
  selector: 'mc-note',
  imports: [AppBar, McI18nPipe, Markdown, PhoneIcon],
  templateUrl: './note.html',
  styleUrls: ['../phone/kit.css', './note.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Note {
  protected readonly phone = phoneSignal();
  protected readonly store = inject(NotesStore);
  private readonly i18n = inject(McI18n);

  /** The segmented control's order: View first, the two ways to write after it. */
  protected readonly modes: readonly MdMode[] = ['view', 'live', 'source'];
  protected readonly folder = computed(() => {
    const path = this.store.path();
    return path === null ? '' : folderOfPath(path);
  });
  protected readonly when = computed(() => {
    const conflict = this.store.conflict();
    return conflict === null ? '' : this.i18n.formatRelative(new Date(conflict.mtime));
  });

  // --- the phone's note (boards 10l, 10p) --------------------------------------

  /** The note's text as read: no frontmatter, and its first heading stands above the tags. */
  private readonly viewParts = computed(() => {
    const text = this.store.draft().replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
    const heading = /^# +(.+)\n?/.exec(text);
    return { title: heading?.[1]?.trim() ?? this.store.name(), body: heading === null ? text : text.slice(heading[0].length).trimStart() };
  });
  protected readonly viewTitle = computed(() => this.viewParts().title);
  /** The body without its tag-only line: the pills above stand for it. */
  protected readonly viewBody = computed(() => this.viewParts().body.replace(/^(#[\w/-]+[ \t]*)+\n+/, '').trimEnd());

  protected readonly pathLine = computed(() => {
    const path = this.store.path() ?? '';
    const mtime = this.store.mtime();
    return mtime === 0 ? path : this.i18n.t('notes.phone.path_edited', { path, when: noteWhenOf(mtime, Date.now(), this.i18n) });
  });

  private readonly ticketInfo = computed(() => {
    const id = this.store.ticketId();
    return id === null ? null : (this.store.ticketSummary(id) ?? { title: id, phase: '' });
  });
  protected readonly ticketTitle = computed(() => this.ticketInfo()?.title ?? '');
  protected readonly ticketLine = computed(() => {
    const id = this.store.ticketId() ?? '';
    const info = this.ticketInfo();
    return info === null || info.phase === '' ? id : this.i18n.t('notes.phone.ticket_line', { id, phase: info.phase });
  });

  /** The bar above the keyboard (board 10p), the strip's actions on the board's icons. */
  protected readonly formatButtons = PHONE_FORMAT_BUTTONS;

  /** A button with no action types the tag's `#` at the caret. */
  protected format(editor: Markdown, action: ToolbarAction | null): void {
    if (action === null) {
      editor.insertAtCaret('#');
    } else {
      editor.apply(action);
    }
  }

  protected modeLabel(mode: MdMode): string {
    return this.i18n.t(`notes.mode.${mode}`);
  }

  protected pick(mode: MdMode): void {
    this.store.pickMode(mode);
  }

  protected onText(text: string): void {
    this.store.setDraft(text);
  }
}
