import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';

import type { ToolbarButtonContrib } from '../../../shared/plugin-api/renderer';
import { Icon, IconName } from '../icons/icon';
import { KeybindingService } from '../keybindings';
import { ToolbarContributionsService } from '../plugin-host';
import { ToolbarAction } from './toolbar-commands';

/**
 * The formatting buttons in the editor's meta bar (milestone 43: merged
 * into the bar, icon-only, drawn from the shared icon set). Pure emitter:
 * every button turns into a `ToolbarAction`; the `Editor` hands it to its
 * `MarkdownSurface`, which owns the CodeMirror view and applies it.
 */
@Component({
  selector: 'app-markdown-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="bar">
      <!-- Heading level -->
      <div class="group">
        <button
          type="button"
          class="icon-btn tb-btn"
          title="Heading"
          aria-label="Heading level"
          aria-haspopup="menu"
          (click)="toggleMenu('heading', $event)"
        >
          <app-icon name="heading" [size]="14" [strokeWidth]="1.5" />
        </button>
        @if (menuOpen() === 'heading') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <nav class="menu" role="menu" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            @for (h of headings; track h.level) {
              <button type="button" role="menuitem" (click)="emit({ kind: 'heading', level: h.level })">
                {{ h.label }}
              </button>
            }
          </nav>
        }
      </div>

      <button
        type="button"
        class="icon-btn tb-btn"
        title="Bold"
        aria-label="Bold"
        (click)="emit({ kind: 'wrap', marker: '**' })"
      >
        <app-icon name="bold" [size]="14" [strokeWidth]="1.5" />
      </button>
      <button
        type="button"
        class="icon-btn tb-btn"
        title="Italic"
        aria-label="Italic"
        (click)="emit({ kind: 'wrap', marker: '*' })"
      >
        <app-icon name="italic" [size]="14" [strokeWidth]="1.5" />
      </button>
      <button
        type="button"
        class="icon-btn tb-btn"
        title="Strikethrough"
        aria-label="Strikethrough"
        (click)="emit({ kind: 'wrap', marker: '~~' })"
      >
        <app-icon name="strikethrough" [size]="14" [strokeWidth]="1.5" />
      </button>

      <span class="divider" aria-hidden="true"></span>

      <!-- Lists -->
      <div class="group">
        <button
          type="button"
          class="icon-btn tb-btn"
          title="List"
          aria-label="List style"
          aria-haspopup="menu"
          (click)="toggleMenu('list', $event)"
        >
          <app-icon name="list" [size]="14" [strokeWidth]="1.5" />
        </button>
        @if (menuOpen() === 'list') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <nav class="menu" role="menu" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <button type="button" role="menuitem" (click)="emit({ kind: 'list', style: 'bullet' })">
              Bullet list
            </button>
            <button
              type="button"
              role="menuitem"
              (click)="emit({ kind: 'list', style: 'ordered' })"
            >
              Numbered list
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'list', style: 'task' })">
              Task list
            </button>
          </nav>
        }
      </div>

      <!-- Task list as its own button (the one list style with a workflow
           behind it -- the Tasks panel picks these up). -->
      <button
        type="button"
        class="icon-btn tb-btn"
        title="Task list"
        aria-label="Task list"
        (click)="emit({ kind: 'list', style: 'task' })"
      >
        <app-icon name="check-square" [size]="14" [strokeWidth]="1.5" />
      </button>
      <button
        type="button"
        class="icon-btn tb-btn"
        title="Blockquote"
        aria-label="Blockquote"
        (click)="emit({ kind: 'quote' })"
      >
        <app-icon name="quote" [size]="14" [strokeWidth]="1.5" />
      </button>

      <span class="divider" aria-hidden="true"></span>

      <button
        type="button"
        class="icon-btn tb-btn"
        title="Link"
        aria-label="Insert link"
        (click)="emit({ kind: 'link' })"
      >
        <app-icon name="link" [size]="14" [strokeWidth]="1.5" />
      </button>

      @if (imagesEnabled()) {
        <button
          type="button"
          class="icon-btn tb-btn"
          title="Image"
          aria-label="Insert image"
          (click)="imageInput.click()"
        >
          <app-icon name="image" [size]="14" [strokeWidth]="1.5" />
        </button>
        <input
          #imageInput
          type="file"
          accept="image/*"
          multiple
          hidden
          (change)="pickImages(imageInput)"
        />
      }

      <!-- Table insert -->
      <div class="group">
        <button
          type="button"
          class="icon-btn tb-btn"
          title="Table"
          aria-label="Insert table"
          aria-haspopup="menu"
          (click)="toggleTableMenu($event)"
        >
          <app-icon name="table" [size]="14" [strokeWidth]="1.5" />
        </button>
        @if (menuOpen() === 'table') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <div class="menu table-menu" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <span class="grid-label">
              @if (tableHover(); as h) {
                {{ h.r + 1 }} &times; {{ h.c + 1 }}
              }
            </span>
            <div class="grid" (mouseleave)="tableHover.set(null)">
              @for (r of gridRange; track r) {
                @for (c of gridRange; track c) {
                  <button
                    type="button"
                    class="cell"
                    [class.on]="isCellOn(r, c)"
                    [attr.aria-label]="'Insert table ' + (r + 1) + ' by ' + (c + 1)"
                    (mouseenter)="tableHover.set({ r: r, c: c })"
                    (click)="emit({ kind: 'table', rows: r + 1, cols: c + 1 })"
                  ></button>
                }
              }
            </div>
          </div>
        }
      </div>

      <!-- Plugin buttons (SDK 1.16), after the built-in ones. -->
      @if (contributed().length > 0) {
        <span class="divider" aria-hidden="true"></span>
        @for (button of contributed(); track button) {
          <button
            type="button"
            class="icon-btn tb-btn"
            [title]="button.title"
            [attr.aria-label]="button.title"
            (click)="runContributed(button)"
          >
            <app-icon [name]="iconOf(button)" [size]="14" [strokeWidth]="1.5" />
          </button>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .group {
      position: relative;
      display: inline-flex;
    }
    .divider {
      width: 1px;
      height: 16px;
      margin: 0 6px;
      background: var(--border);
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 45;
    }
    .menu {
      /* Fixed, anchored under the trigger button (see anchorFrom): the meta
         bar clips its contents (overflow hidden), so an absolute menu would
         be cut off to a sliver at the bar's bottom edge. */
      position: fixed;
      z-index: 46;
      display: flex;
      flex-direction: column;
      min-width: 140px;
      padding: 4px;
      background: var(--bg-input);
      border: 1px solid var(--popover-border);
      border-radius: var(--radius-md);
      box-shadow: var(--popover-shadow);
    }
    .menu button {
      padding: 6px 8px;
      border: none;
      border-radius: var(--radius-xs);
      background: none;
      color: var(--text-2);
      font: 400 13px/1.3 var(--font-sans);
      text-align: left;
      cursor: pointer;
    }
    .menu button:hover {
      background: var(--hover-bg-strong);
      color: var(--text-primary);
    }
    .table-menu {
      min-width: 0;
      gap: 6px;
      padding: 8px;
    }
    .grid-label {
      min-height: 14px;
      color: var(--text-4);
      font: 400 11px/1 var(--font-sans);
      text-align: center;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(5, 18px);
      grid-auto-rows: 18px;
      gap: 3px;
    }
    .grid .cell {
      padding: 0;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xs);
      background: var(--hover-bg);
      cursor: pointer;
    }
    .grid .cell.on {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 35%, transparent);
    }
  `,
})
export class MarkdownToolbar {
  /** Shows the image button (the surface can save assets into the vault). */
  readonly imagesEnabled = input(false);

  readonly action = output<ToolbarAction>();
  /** Picture files chosen through the image button; the surface saves them into the vault. */
  readonly imageFiles = output<File[]>();

  private readonly keys = inject(KeybindingService);
  protected readonly contributed = inject(ToolbarContributionsService).buttons;

  protected readonly menuOpen = signal<'heading' | 'list' | 'table' | null>(null);

  /** Viewport anchor for the open menu, taken from the trigger button. */
  protected readonly menuPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  protected readonly headings: { level: 0 | 1 | 2 | 3; label: string }[] = [
    { level: 0, label: 'Body text' },
    { level: 1, label: 'Heading 1' },
    { level: 2, label: 'Heading 2' },
    { level: 3, label: 'Heading 3' },
  ];

  /** The table picker: a 5x5 grid of cells, hover-selected like in Word. */
  protected readonly gridRange = [0, 1, 2, 3, 4];

  protected readonly tableHover = signal<{ r: number; c: number } | null>(null);

  protected toggleMenu(which: 'heading' | 'list', event: MouseEvent): void {
    if (this.menuOpen() === which) {
      this.menuOpen.set(null);
      return;
    }
    this.anchorFrom(event);
    this.menuOpen.set(which);
  }

  protected toggleTableMenu(event: MouseEvent): void {
    if (this.menuOpen() === 'table') {
      this.menuOpen.set(null);
      return;
    }
    this.tableHover.set(null);
    this.anchorFrom(event);
    this.menuOpen.set('table');
  }

  /** Anchors the menu just below the trigger button. The 150px clamp keeps
      a near-right-edge button from pushing the menu out of the window. */
  private anchorFrom(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuPos.set({
      x: Math.max(0, Math.round(Math.min(rect.left, window.innerWidth - 150))),
      y: Math.round(rect.bottom + 4),
    });
  }

  /** True for every cell up to and including the hovered one (row AND col). */
  protected isCellOn(r: number, c: number): boolean {
    const h = this.tableHover();
    return h !== null && r <= h.r && c <= h.c;
  }

  protected pickImages(el: HTMLInputElement): void {
    const files = Array.from(el.files ?? []);
    // Reset so picking the same file again still fires `change`.
    el.value = '';
    if (files.length > 0) {
      this.imageFiles.emit(files);
    }
  }

  /** The icon component draws an empty glyph for a name it does not know. */
  protected iconOf(button: ToolbarButtonContrib): IconName {
    return button.icon as IconName;
  }

  protected runContributed(button: ToolbarButtonContrib): void {
    this.menuOpen.set(null);
    if (button.commandId !== undefined) {
      this.keys.run(button.commandId);
    } else {
      button.run?.();
    }
  }

  protected emit(action: ToolbarAction): void {
    this.menuOpen.set(null);
    this.tableHover.set(null);
    this.action.emit(action);
  }
}
