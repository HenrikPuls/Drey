import { Injectable, computed, inject, signal } from '@angular/core';
import {
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectLine,
  undo,
} from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { KeybindingService } from '../keybindings';
import { DockService, PanelId } from '../dock';
import { EditorService } from '../services/editor.service';
import { EditTargetService } from '../services/edit-target.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../services/vault.service';
import { duplicateSelection, toggleTaskDone } from '../editor/markdown-commands';
import type { EditCommand } from '../../../shared/ipc-api';

export type MenuId = 'file' | 'edit' | 'selection' | 'view';

/** One row in a menu popover. `run` absent => the row is shown disabled. */
export interface MenuItem {
  readonly kind: 'item';
  readonly label: string;
  /** Shortcut hint, right-aligned (mono). */
  readonly hint?: string;
  readonly run?: () => void;
  /** When set, a check mark shows while it returns true. */
  readonly checked?: () => boolean;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

export type MenuRow = MenuItem | MenuSeparator;

export interface MenuDef {
  readonly id: MenuId;
  readonly label: string;
  readonly rows: readonly MenuRow[];
}

const SEP: MenuSeparator = { kind: 'separator' };

/**
 * Backs the HTML menu bar in `Titlebar` (the window is frameless, so
 * File/Edit/Selection/View live here, ADR-0019). Open/close + hover-switch
 * behaviour is DESIGN.md "Titlebar": click toggles a menu; while one is
 * open, hovering a sibling switches to it; an outside click closes.
 *
 * Wired rows call through `KeybindingService` (so the command and its
 * shortcut stay one definition) or a service directly. Un-wired rows are
 * rendered disabled -- they are placeholders for later milestones, not
 * dead code to delete.
 */
@Injectable({ providedIn: 'root' })
export class MenuService {
  private readonly keys = inject(KeybindingService);
  private readonly dock = inject(DockService);
  private readonly editor = inject(EditorService);
  private readonly editTarget = inject(EditTargetService);
  private readonly settings = inject(SettingsService);
  private readonly vault = inject(VaultService);

  readonly open = signal<MenuId | null>(null);

  toggle(id: MenuId): void {
    this.open.update((cur) => (cur === id ? null : id));
  }

  /** Hovering a sibling while a menu is open switches straight to it. */
  hover(id: MenuId): void {
    if (this.open() !== null && this.open() !== id) {
      this.open.set(id);
    }
  }

  close(): void {
    this.open.set(null);
  }

  private run(commandId: string): void {
    this.close();
    this.keys.run(commandId);
  }

  /**
   * A standard editing command from the Edit / Selection menu.
   *
   * When a CodeMirror surface last held focus, act on it directly:
   * `undo` / `redo` / `selectAll` as CM commands (a menu click can't reach
   * CM's private history through `webContents.undo()`, and
   * `document.execCommand('undo')` is a no-op on CM's contenteditable),
   * and `cut` / `copy` / `paste` as native `webContents` clipboard ops
   * *after re-focusing the view* so the OS clipboard acts on the editor
   * and not on whatever the menu click left focused. With no editor
   * focused (a native `<input>` in Settings, the entry topic field) fall
   * straight through to `webContents`.
   */
  private exec(command: EditCommand): void {
    this.close();
    const view = this.editTarget.view;
    const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
    if (view) {
      view.focus();
      if (command === 'undo') {
        undo(view);
        return;
      }
      if (command === 'redo') {
        redo(view);
        return;
      }
      if (command === 'selectAll') {
        selectAll(view);
        return;
      }
    }
    void api?.execEditCommand(command);
  }

  /**
   * A menu row that runs a CodeMirror command against the surface that last
   * held focus. Returns `undefined` when there is none, so the row renders
   * disabled (the menu template keys off a missing `run`).
   */
  private editorRow(
    label: string,
    hint: string,
    command: (view: EditorView) => boolean,
    refocus = true,
  ): MenuItem {
    return {
      kind: 'item',
      label,
      hint: hint || undefined,
      run: this.editTarget.hasView()
        ? () => {
            this.close();
            const view = this.editTarget.view;
            if (view) {
              command(view);
              // Give focus back to the editor afterwards -- except for
              // commands that move focus somewhere deliberate (the search
              // panel's input).
              if (refocus) {
                view.focus();
              }
            }
          }
        : undefined,
    };
  }

  private panelRow(id: PanelId, label: string): MenuItem {
    return {
      kind: 'item',
      label,
      checked: () => !this.dock.collapsed(id),
      run: () => {
        this.close();
        this.dock.toggleCollapse(id);
      },
    };
  }

  readonly menus = computed<readonly MenuDef[]>(() => [
    {
      id: 'file',
      label: 'File',
      rows: [
        { kind: 'item', label: 'New note', hint: 'Ctrl N', run: () => this.run('note.new') },
        SEP,
        {
          kind: 'item',
          label: 'Switch vault …',
          run: () => {
            this.close();
            void this.vault.selectVault();
            this.dock.openAndExpand('files');
          },
        },
        SEP,
        { kind: 'item', label: 'Save', hint: 'Ctrl S', run: () => this.run('note.save') },
        {
          kind: 'item',
          label: 'Save all',
          hint: 'Ctrl Alt S',
          run: () => this.run('note.saveAll'),
        },
        SEP,
        {
          kind: 'item',
          label: 'Settings',
          hint: 'Ctrl ,',
          run: () => {
            this.close();
            this.settings.openScreen();
          },
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      rows: [
        { kind: 'item', label: 'Undo', hint: 'Ctrl Z', run: () => this.exec('undo') },
        { kind: 'item', label: 'Redo', hint: 'Ctrl Shift Z', run: () => this.exec('redo') },
        SEP,
        { kind: 'item', label: 'Cut', hint: 'Ctrl X', run: () => this.exec('cut') },
        { kind: 'item', label: 'Copy', hint: 'Ctrl C', run: () => this.exec('copy') },
        { kind: 'item', label: 'Paste', hint: 'Ctrl V', run: () => this.exec('paste') },
        SEP,
        this.editorRow('Find in note', 'Ctrl F', (view) => openSearchPanel(view), false),
        {
          kind: 'item',
          label: 'Search all notes',
          hint: 'Ctrl Shift F',
          run: () => this.run('search.open'),
        },
      ],
    },
    {
      id: 'selection',
      label: 'Selection',
      rows: [
        { kind: 'item', label: 'Select all', hint: 'Ctrl A', run: () => this.exec('selectAll') },
        this.editorRow('Select line', 'Ctrl L', selectLine),
        SEP,
        this.editorRow('Duplicate selection', '', (view) => duplicateSelection(view)),
        this.editorRow('Move line up', 'Alt Up', moveLineUp),
        this.editorRow('Move line down', 'Alt Down', moveLineDown),
        SEP,
        this.editorRow('Toggle task done', 'Ctrl Enter', (view) => toggleTaskDone(view)),
      ],
    },
    {
      id: 'view',
      label: 'View',
      rows: [
        {
          kind: 'item',
          label: 'Line numbers',
          hint: 'Ctrl G',
          checked: () => this.editor.lineNumbers(),
          run: () => this.run('editor.toggleLineNumbers'),
        },
        this.panelRow('calendar', 'Calendar'),
        this.panelRow('files', 'Files'),
        this.panelRow('search', 'Search'),
        this.panelRow('windows', 'Open windows'),
        this.panelRow('assistant', 'Assistant'),
        SEP,
        {
          kind: 'item',
          label: 'Reset layout',
          run: () => {
            this.close();
            this.dock.reset();
          },
        },
      ],
    },
  ]);
}
