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
import { DockService, WidgetId, WidgetRegistryService } from '../dock';
import {
  MenuContributionsService,
  type ContributableMenu,
} from '../plugin-host/menu-contributions.service';
import { PaneService } from '../panes';
import { DocHistoryService } from '../services/doc-history.service';
import { EditorService } from '../services/editor.service';
import { EditTargetService } from '../services/edit-target.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault';
import { WindowChromeService } from './window-chrome.service';
import { duplicateSelection } from '../editor/markdown-commands';
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
  private readonly panes = inject(PaneService);
  private readonly editor = inject(EditorService);
  private readonly history = inject(DocHistoryService);
  private readonly editTarget = inject(EditTargetService);
  private readonly settings = inject(SettingsService);
  private readonly vault = inject(VaultService);
  private readonly widgets = inject(WidgetRegistryService);
  private readonly contributions = inject(MenuContributionsService);
  private readonly windowChrome = inject(WindowChromeService);

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
   * A standard editing command from the Edit / Selection menu -- also the
   * clipboard rows of the editor's right-click menu (ADR-0030).
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
   *
   * The right-click menu passes the view of the surface it was opened on
   * (`target`) so the command lands there instead of on the last-focused
   * pane editor -- plugin composer surfaces never register with
   * `EditTargetService`, and a right-click must act where it clicked.
   */
  execEdit(command: EditCommand, target?: EditorView | null): void {
    this.close();
    const view = target !== undefined ? target : this.editTarget.view;
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

  /**
   * A View-menu row that opens / closes a panel (ADR-0034): the check mark
   * tracks whether it is open, and a click does what its icon in the dock
   * strip does.
   */
  private widgetRow(id: WidgetId, label: string): MenuItem {
    return {
      kind: 'item',
      label,
      checked: () => !this.dock.closed(id),
      run: () => {
        this.close();
        this.dock.toggle(id);
      },
    };
  }

  /**
   * Plugin-contributed rows for one menu (ADR-0044 stage 2), appended after
   * the built-ins behind a separator. A row runs a registered command or
   * the contribution's own closure; `run` absent renders it disabled.
   */
  private contributionRows(menu: ContributableMenu): MenuRow[] {
    const items = this.contributions.itemsFor(menu);
    if (items.length === 0) {
      return [];
    }
    return [
      SEP,
      ...items.map((item) => ({
        kind: 'item' as const,
        label: item.label,
        ...(item.hint !== undefined ? { hint: item.hint } : {}),
        run: item.commandId
          ? () => this.run(item.commandId!)
          : item.run
            ? () => {
                this.close();
                item.run!();
              }
            : undefined,
      })),
    ];
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
          label: 'Add vault …',
          run: () => {
            this.close();
            void this.vault.addVault();
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
        ...this.contributionRows('file'),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      rows: [
        { kind: 'item', label: 'Undo', hint: 'Ctrl Z', run: () => this.execEdit('undo') },
        { kind: 'item', label: 'Redo', hint: 'Ctrl Shift Z', run: () => this.execEdit('redo') },
        SEP,
        { kind: 'item', label: 'Cut', hint: 'Ctrl X', run: () => this.execEdit('cut') },
        { kind: 'item', label: 'Copy', hint: 'Ctrl C', run: () => this.execEdit('copy') },
        { kind: 'item', label: 'Paste', hint: 'Ctrl V', run: () => this.execEdit('paste') },
        SEP,
        this.editorRow('Find in note', 'Ctrl F', (view) => openSearchPanel(view), false),
        {
          kind: 'item',
          label: 'Search all notes',
          hint: 'Ctrl Shift F',
          run: () => this.run('search.open'),
        },
        ...this.contributionRows('edit'),
      ],
    },
    {
      id: 'selection',
      label: 'Selection',
      rows: [
        { kind: 'item', label: 'Select all', hint: 'Ctrl A', run: () => this.execEdit('selectAll') },
        this.editorRow('Select line', 'Ctrl L', selectLine),
        SEP,
        this.editorRow('Duplicate selection', '', (view) => duplicateSelection(view)),
        this.editorRow('Move line up', 'Alt Up', moveLineUp),
        this.editorRow('Move line down', 'Alt Down', moveLineDown),
        // "Toggle task done" is a Tasks-plugin menu contribution now.
        ...this.contributionRows('selection'),
      ],
    },
    {
      id: 'view',
      label: 'View',
      rows: [
        {
          kind: 'item',
          label: 'Back',
          hint: 'Alt Left',
          run: this.history.canBack() ? () => this.run('doc.back') : undefined,
        },
        {
          kind: 'item',
          label: 'Forward',
          hint: 'Alt Right',
          run: this.history.canForward() ? () => this.run('doc.forward') : undefined,
        },
        { kind: 'item', label: 'Go to file…', hint: 'Ctrl P', run: () => this.run('palette.files') },
        {
          kind: 'item',
          label: 'Command palette…',
          hint: 'Ctrl Shift P',
          run: () => this.run('palette.commands'),
        },
        SEP,
        {
          kind: 'item',
          label: 'Line numbers',
          hint: 'Ctrl G',
          checked: () => this.editor.lineNumbers(),
          run: () => this.run('editor.toggleLineNumbers'),
        },
        {
          kind: 'item',
          label: 'Left dock',
          hint: 'Ctrl B',
          checked: () => !this.dock.sideFolded('left'),
          run: () => this.run('dock.toggleLeft'),
        },
        {
          kind: 'item',
          label: 'Right dock',
          hint: 'Ctrl Alt B',
          checked: () => !this.dock.sideFolded('right'),
          run: () => this.run('dock.toggleRight'),
        },
        SEP,
        ...this.widgets
          .widgets()
          .filter((w) => w.removable && this.settings.widgetEnabled(w.id))
          .map((w) => this.widgetRow(w.id, w.title)),
        SEP,
        {
          kind: 'item',
          label: 'Full screen',
          hint: 'F11',
          checked: () => this.windowChrome.fullscreen(),
          run: () => this.run('window.toggleFullScreen'),
        },
        {
          kind: 'item',
          label: 'Split editor right',
          hint: 'Ctrl Alt Enter',
          run: this.editor.openDocs().length > 0 ? () => this.run('pane.splitRight') : undefined,
        },
        {
          kind: 'item',
          label: 'Split editor down',
          hint: 'Ctrl Alt Shift Enter',
          run: this.editor.openDocs().length > 0 ? () => this.run('pane.splitDown') : undefined,
        },
        {
          kind: 'item',
          label: 'Focus next pane',
          hint: 'F6',
          run: this.panes.paneIds().length > 1 ? () => this.run('pane.focusNext') : undefined,
        },
        {
          kind: 'item',
          label: 'Focus previous pane',
          hint: 'Shift F6',
          run: this.panes.paneIds().length > 1 ? () => this.run('pane.focusPrev') : undefined,
        },
        {
          kind: 'item',
          label: 'Reset layout',
          run: () => {
            this.close();
            this.dock.reset();
            // The editor half of the reset: docked panes back to the
            // centre, band heights back to default (ADR-0038).
            this.panes.resetRegions();
          },
        },
        ...this.contributionRows('view'),
      ],
    },
  ]);
}
