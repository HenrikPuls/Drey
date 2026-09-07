import { Injectable, computed, inject, signal } from '@angular/core';
import { KeybindingService } from '../keybindings';
import { DockService, PanelId } from '../dock';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../services/vault.service';

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
        { kind: 'item', label: 'New window', hint: 'Ctrl Shift N' },
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
        { kind: 'item', label: 'Undo', hint: 'Ctrl Z' },
        { kind: 'item', label: 'Redo', hint: 'Ctrl Shift Z' },
        SEP,
        { kind: 'item', label: 'Cut', hint: 'Ctrl X' },
        { kind: 'item', label: 'Copy', hint: 'Ctrl C' },
        { kind: 'item', label: 'Paste', hint: 'Ctrl V' },
        SEP,
        { kind: 'item', label: 'Find in note', hint: 'Ctrl F' },
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
        { kind: 'item', label: 'Select all', hint: 'Ctrl A' },
        { kind: 'item', label: 'Select line', hint: 'Ctrl L' },
        SEP,
        { kind: 'item', label: 'Duplicate selection', hint: 'Ctrl D' },
        { kind: 'item', label: 'Move line up', hint: 'Alt Up' },
        { kind: 'item', label: 'Move line down', hint: 'Alt Down' },
        SEP,
        { kind: 'item', label: 'Toggle task done', hint: 'Ctrl Enter' },
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
