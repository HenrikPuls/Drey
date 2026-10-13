import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { CalloutKind } from '../../../shared/markdown/callouts';
import type { ToolbarButtonContrib } from '../../../shared/plugin-api/renderer';
import { Icon, IconName } from '../icons/icon';
import { KeybindingService } from '../keybindings';
import { ToolbarContributionsService } from '../plugin-host';
import { ParagraphStyle, ToolbarAction, paragraphStyleOf } from './toolbar-commands';

type MenuId = 'host' | 'paragraph' | 'format' | 'list' | 'table' | 'insert' | 'plugin';

/**
 * The formatting strip (req-41): ten buttons, the rare and the
 * one-of-several commands behind five menus -- paragraph style, more
 * text formats, list, table, insert. One component, two placements: docked in
 * the editor's meta bar while pinned, and floating as the head of the
 * editor context menu (`overlay`), where it acts on whichever surface
 * was right-clicked. Plugin buttons (SDK 1.16 / 1.21) are rows of the
 * Insert menu, or an icon of their own at the leading edge when they
 * ask for `placement: 'bar'` -- with their own popover if they bring one.
 *
 * Pure emitter: every command turns into an output; the host (the
 * `Editor`, the context menu) applies it to its CodeMirror view.
 */
@Component({
  selector: 'app-markdown-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '[class.overlay]': 'overlay()' },
  template: `
    <div class="bar">
      @if (pinned() !== null && !overlay()) {
        <button
          type="button"
          class="icon-btn tb-btn pin"
          [title]="pinned() ? 'Unpin formatting toolbar' : 'Pin formatting toolbar'"
          [attr.aria-label]="pinned() ? 'Unpin formatting toolbar' : 'Pin formatting toolbar'"
          [attr.aria-pressed]="pinned()"
          (click)="togglePin()"
        >
          <app-icon name="pin" [size]="14" [strokeWidth]="1.5" />
        </button>
        <span class="divider" aria-hidden="true"></span>
      }

      <!-- The host's own menu as the strip's first menu (the editor
           context menu's clipboard list): the host draws it under the
           strip while this button is open, and it starts open. -->
      @if (hostMenu(); as hostTitle) {
        <button
          type="button"
          class="icon-btn tb-btn drop host-menu"
          [class.open]="menuOpen() === 'host'"
          [title]="hostTitle"
          [attr.aria-label]="hostTitle"
          aria-haspopup="menu"
          [attr.aria-expanded]="menuOpen() === 'host'"
          (click)="toggleMenu('host', $event)"
        >
          <app-icon name="copy" [size]="14" [strokeWidth]="1.5" />
          <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
        </button>
      }

      <!-- Plugin buttons that asked for a place in the bar (SDK 1.21). -->
      @for (button of barButtons(); track button; let i = $index) {
        <button
          type="button"
          class="icon-btn tb-btn"
          [class.drop]="button.popover !== undefined"
          [class.open]="menuOpen() === 'plugin' && pluginIndex() === i"
          [title]="button.title"
          [attr.aria-label]="button.title"
          [attr.aria-haspopup]="button.popover !== undefined ? 'dialog' : null"
          (click)="clickBarButton(button, i, $event)"
        >
          <app-icon [name]="iconOf(button)" [size]="14" [strokeWidth]="1.5" />
          @if (button.popover !== undefined) {
            <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
          }
        </button>
      }
      @if (barButtons().length > 0 || hostMenu() !== null) {
        <span class="divider" aria-hidden="true"></span>
      }

      <button
        type="button"
        class="icon-btn tb-btn drop"
        [class.open]="menuOpen() === 'paragraph'"
        title="Paragraph style"
        aria-label="Paragraph style"
        aria-haspopup="menu"
        (click)="toggleMenu('paragraph', $event)"
      >
        <app-icon name="pilcrow" [size]="14" [strokeWidth]="1.5" />
        <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
      </button>
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
        class="icon-btn tb-btn drop"
        [class.open]="menuOpen() === 'format'"
        title="More text formats"
        aria-label="More text formats"
        aria-haspopup="menu"
        (click)="toggleMenu('format', $event)"
      >
        <app-icon name="baseline" [size]="14" [strokeWidth]="1.5" />
        <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
      </button>

      <span class="divider" aria-hidden="true"></span>

      <button
        type="button"
        class="icon-btn tb-btn drop"
        [class.open]="menuOpen() === 'list'"
        title="List"
        aria-label="List style"
        aria-haspopup="menu"
        (click)="toggleMenu('list', $event)"
      >
        <app-icon name="list" [size]="14" [strokeWidth]="1.5" />
        <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
      </button>
      <!-- Task list stays a button of its own: the one list style with a
           workflow behind it (the Tasks panel picks these up). -->
      <button
        type="button"
        class="icon-btn tb-btn"
        title="Task list"
        aria-label="Task list"
        (click)="emit({ kind: 'list', style: 'task' })"
      >
        <app-icon name="check-square" [size]="14" [strokeWidth]="1.5" />
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
      <button
        type="button"
        class="icon-btn tb-btn drop"
        [class.open]="menuOpen() === 'table'"
        title="Table"
        aria-label="Insert table"
        aria-haspopup="menu"
        (click)="toggleMenu('table', $event)"
      >
        <app-icon name="table" [size]="14" [strokeWidth]="1.5" />
        <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
      </button>
      <button
        type="button"
        class="icon-btn tb-btn drop"
        [class.open]="menuOpen() === 'insert'"
        title="Insert"
        aria-label="Insert"
        aria-haspopup="menu"
        (click)="toggleMenu('insert', $event)"
      >
        <app-icon name="plus" [size]="14" [strokeWidth]="1.5" />
        <app-icon class="caret" name="chevron-down" [size]="8" [strokeWidth]="3" />
      </button>

      @if (pinned() !== null && overlay()) {
        <span class="divider" aria-hidden="true"></span>
        <button
          type="button"
          class="icon-btn tb-btn pin"
          [title]="pinned() ? 'Unpin formatting toolbar' : 'Pin formatting toolbar'"
          [attr.aria-label]="pinned() ? 'Unpin formatting toolbar' : 'Pin formatting toolbar'"
          [attr.aria-pressed]="pinned()"
          (click)="togglePin()"
        >
          <app-icon name="pin" [size]="14" [strokeWidth]="1.5" />
        </button>
      }

      <!-- Outside the Insert menu on purpose: the menu closes before the
           OS file dialog answers, the input must outlive it. -->
      @if (imagesEnabled()) {
        <input
          #imageInput
          type="file"
          accept="image/*"
          multiple
          hidden
          (change)="pickImages(imageInput)"
        />
      }
    </div>

    @if (ownMenu(); as open) {
      <div class="backdrop" (click)="closeMenu()" (contextmenu)="$event.preventDefault(); closeMenu()"></div>
      @switch (open) {
        @case ('paragraph') {
          <nav class="menu" role="menu" aria-label="Paragraph style" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            @for (p of paragraphs; track p.label) {
              @if (p.separated) {
                <div class="menu-sep" role="separator"></div>
              }
              <button
                type="button"
                role="menuitemradio"
                [class.current]="currentStyle() === p.style"
                [attr.aria-checked]="currentStyle() === p.style"
                (click)="emit(p.action)"
              >
                {{ p.label }}
              </button>
            }
            <div class="menu-sep" role="separator"></div>
            <span class="menu-label">Callout</span>
            @for (c of callouts; track c.variant) {
              <button type="button" role="menuitem" (click)="emit({ kind: 'callout', variant: c.variant })">
                {{ c.icon }}&nbsp;{{ c.label }}
              </button>
            }
          </nav>
        }
        @case ('format') {
          <nav class="menu" role="menu" aria-label="More text formats" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <button type="button" role="menuitem" (click)="emit({ kind: 'wrap', marker: '~~' })">
              Strikethrough <span class="menu-hint">~~x~~</span>
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'highlight' })">
              Highlight <span class="menu-hint">==x==</span>
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'superscript' })">
              Superscript <span class="menu-hint">X^2^</span>
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'subscript' })">
              Subscript <span class="menu-hint">H~2~O</span>
            </button>
            <div class="menu-sep" role="separator"></div>
            <!-- The formatting eraser (M72): peels the outermost inline wrap
                 at the caret / wipes every wrap the selection overlaps. -->
            <button type="button" role="menuitem" (click)="erase()">
              Clear formatting <span class="menu-key">Ctrl \\</span>
            </button>
          </nav>
        }
        @case ('list') {
          <nav class="menu" role="menu" aria-label="List style" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <button type="button" role="menuitem" (click)="emit({ kind: 'list', style: 'bullet' })">
              Bullet list
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'list', style: 'ordered' })">
              Numbered list
            </button>
          </nav>
        }
        @case ('insert') {
          <nav class="menu" role="menu" aria-label="Insert" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            @if (imagesEnabled()) {
              <button type="button" role="menuitem" (click)="chooseImages()">Image…</button>
            }
            <!-- Plugin buttons (SDK 1.16): one row each, labelled by title. -->
            @for (button of insertButtons(); track button) {
              <button type="button" role="menuitem" (click)="runContributed(button)">
                {{ button.title }}
              </button>
            }
            <button type="button" role="menuitem" (click)="pickEmoji()">Emoji…</button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'footnote' })">Footnote</button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'mathInline' })">
              Inline math <span class="menu-hint">$x^2$</span>
            </button>
            <button type="button" role="menuitem" (click)="emit({ kind: 'mathBlock' })">
              Math block <span class="menu-hint">$$…$$</span>
            </button>
          </nav>
        }
        @case ('table') {
          <!-- The table picker: a 5x5 grid, hover-selected like in Word. -->
          <nav class="menu table-menu" role="menu" aria-label="Insert table" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <span class="menu-label">
              Table
              <span class="grid-size">
                @if (tableHover(); as h) {
                  {{ h.r + 1 }} &times; {{ h.c + 1 }}
                }
              </span>
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
          </nav>
        }
        @case ('plugin') {
          <!-- A plugin's own popover: the host owns the box and its anchor,
               the plugin mounts plain DOM into the unstyled inner node. -->
          <div class="menu plugin-pop" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y">
            <div #pluginPop></div>
          </div>
        }
      }
    }
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
    /* A menu button: the glyph plus a small caret, so it reads apart from
       the buttons that act at once. */
    .tb-btn.drop {
      width: 34px;
      gap: 2px;
    }
    .tb-btn .caret {
      opacity: 0.7;
    }
    .tb-btn.open {
      background: var(--hover-bg-strong);
      color: var(--text-primary);
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
      min-width: 190px;
      padding: 4px;
      background: var(--bg-input);
      border: 1px solid var(--popover-border);
      border-radius: var(--radius-md);
      box-shadow: var(--popover-shadow);
    }
    /* In the editor context menu the strip's menus open over the menu
       list and its backdrop (z 60 / 61, editor-context-menu.css). */
    :host(.overlay) .backdrop {
      z-index: 62;
    }
    :host(.overlay) .menu {
      z-index: 63;
    }
    .menu button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
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
    /* The paragraph style the caret's line has. */
    .menu button.current {
      background: var(--hover-bg);
      box-shadow: inset 2px 0 0 var(--accent);
      color: var(--text-primary);
    }
    .menu .menu-hint {
      font: 400 11px/1.3 var(--font-mono, monospace);
      color: var(--text-6);
    }
    .menu .menu-key {
      font: 400 11px/1.3 var(--font-sans);
      color: var(--text-6);
    }
    .menu-sep {
      height: 1px;
      margin: 4px 2px;
      background: var(--border);
    }
    .menu-label {
      display: flex;
      justify-content: space-between;
      padding: 4px 8px 2px;
      color: var(--text-5);
      font: 400 12px/1.3 var(--font-sans);
    }
    .table-menu {
      min-width: 0;
    }
    .plugin-pop {
      min-width: 0;
      padding: 0;
      overflow: hidden;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(5, 18px);
      grid-auto-rows: 18px;
      gap: 3px;
      padding: 4px 8px 6px;
    }
    .menu .grid .cell {
      padding: 0;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-xs);
      background: var(--hover-bg);
      cursor: pointer;
    }
    .menu .grid .cell.on {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 35%, transparent);
    }
  `,
})
export class MarkdownToolbar implements OnInit {
  /** Offers "Image…" (the surface can save assets into the vault). */
  readonly imagesEnabled = input(false);
  /**
   * The pin (req-41): `true` / `false` draws it pressed / released,
   * `null` leaves it out. Docked it leads the bar, floating it ends it.
   */
  readonly pinned = input<boolean | null>(null);
  /** Floating in the editor context menu: menus stack above that menu. */
  readonly overlay = input(false);
  /**
   * Plugin buttons act on the focused pane document; a surface that is
   * none (the entry drawer, a composer) switches them off.
   */
  readonly pluginButtons = input(true);
  /**
   * The host has a menu of its own that belongs with the strip's menus:
   * its title makes it the strip's first menu button. The strip only
   * tracks whether it is open (one menu at a time, like the others) and
   * reports that; the host draws the menu. It starts open.
   */
  readonly hostMenu = input<string | null>(null);
  /** The caret's line, read when the paragraph menu opens (its current mark). */
  readonly currentLine = input<(() => string | null) | null>(null);

  readonly action = output<ToolbarAction>();
  /** Picture files chosen through "Image…"; the surface saves them into the vault. */
  readonly imageFiles = output<File[]>();
  /** "Emoji…": open the `:emoji:` picker at the caret (no reducer -- the
   *  picker service owns the insert, ADR-0070). */
  readonly emojiPick = output<void>();
  /** "Clear formatting": peel formatting at the selection (a tree command,
   *  not a `toolbar-commands.ts` reducer -- "outermost" needs the syntax
   *  tree). */
  readonly clearFormatting = output<void>();
  readonly pinToggle = output<void>();
  /** A plugin button ran or its popover closed -- nothing left for the host to apply. */
  readonly done = output<void>();
  /** The host's menu (`hostMenu`) opened (`true`) or closed -- the host shows / hides it. */
  readonly hostMenuToggled = output<boolean>();

  private readonly keys = inject(KeybindingService);
  private readonly contributed = inject(ToolbarContributionsService).buttons;

  protected readonly barButtons = computed(() =>
    this.pluginButtons() ? this.contributed().filter((b) => b.placement === 'bar') : [],
  );
  protected readonly insertButtons = computed(() =>
    this.pluginButtons() ? this.contributed().filter((b) => b.placement !== 'bar') : [],
  );

  protected readonly menuOpen = signal<MenuId | null>(null);
  /** The open menu the strip draws itself -- everything but the host's. */
  protected readonly ownMenu = computed(() => {
    const open = this.menuOpen();
    return open === 'host' ? null : open;
  });
  /** Which bar button's popover is open while `menuOpen()` is `'plugin'`. */
  protected readonly pluginIndex = signal(-1);

  /** Viewport anchor for the open menu, taken from the trigger button. */
  protected readonly menuPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /** The caret line's style while the paragraph menu is open. */
  protected readonly currentStyle = signal<ParagraphStyle | null>(null);

  protected readonly paragraphs: {
    label: string;
    style: ParagraphStyle;
    action: ToolbarAction;
    separated?: boolean;
  }[] = [
    { label: 'Body text', style: 0, action: { kind: 'heading', level: 0 } },
    { label: 'Heading 1', style: 1, action: { kind: 'heading', level: 1 } },
    { label: 'Heading 2', style: 2, action: { kind: 'heading', level: 2 } },
    { label: 'Heading 3', style: 3, action: { kind: 'heading', level: 3 } },
    { label: 'Blockquote', style: 'quote', action: { kind: 'quote' }, separated: true },
  ];

  /** The callout rows: GitHub's five kinds with their marker glyphs. */
  protected readonly callouts: { variant: CalloutKind; label: string; icon: string }[] = [
    { variant: 'note', label: 'Note', icon: '📝' },
    { variant: 'tip', label: 'Tip', icon: '💡' },
    { variant: 'important', label: 'Important', icon: '❗' },
    { variant: 'warning', label: 'Warning', icon: '⚠️' },
    { variant: 'caution', label: 'Caution', icon: '🔴' },
  ];

  /** The table picker: a 5x5 grid of cells, hover-selected like in Word. */
  protected readonly gridRange = [0, 1, 2, 3, 4];

  protected readonly tableHover = signal<{ r: number; c: number } | null>(null);

  private readonly imageInput = viewChild<ElementRef<HTMLInputElement>>('imageInput');
  private readonly pluginPop = viewChild<ElementRef<HTMLElement>>('pluginPop');

  constructor() {
    effect(() => this.hostMenuToggled.emit(this.menuOpen() === 'host'));

    // A plugin popover: once its box exists, let the plugin mount into it
    // and keep the box inside the window (its width is the plugin's).
    effect((onCleanup) => {
      const host = this.pluginPop()?.nativeElement;
      const button = this.barButtons()[this.pluginIndex()];
      if (host === undefined || button?.popover === undefined) {
        return;
      }
      let dispose: (() => void) | undefined;
      try {
        dispose = button.popover(host, () => this.finish());
      } catch {
        dispose = undefined; // a broken plugin leaves an empty box, not a broken bar
      }
      const width = host.offsetWidth;
      untracked(() =>
        this.menuPos.update((pos) => ({
          x: Math.max(8, Math.min(pos.x, window.innerWidth - width - 8)),
          y: pos.y,
        })),
      );
      onCleanup(() => {
        try {
          dispose?.();
        } catch {
          // teardown of a broken plugin must not break closing the menu
        }
      });
    });
  }

  ngOnInit(): void {
    if (this.hostMenu() !== null) {
      this.menuOpen.set('host');
    }
  }

  protected toggleMenu(which: Exclude<MenuId, 'plugin'>, event: MouseEvent): void {
    if (this.menuOpen() === which) {
      this.closeMenu();
      return;
    }
    if (which === 'paragraph') {
      const line = this.currentLine()?.() ?? null;
      this.currentStyle.set(line === null ? null : paragraphStyleOf(line));
    }
    this.tableHover.set(null);
    this.anchorFrom(event);
    this.menuOpen.set(which);
  }

  protected clickBarButton(button: ToolbarButtonContrib, index: number, event: MouseEvent): void {
    if (button.popover === undefined) {
      this.runContributed(button);
      return;
    }
    if (this.menuOpen() === 'plugin' && this.pluginIndex() === index) {
      this.closeMenu();
      return;
    }
    this.anchorFrom(event);
    this.pluginIndex.set(index);
    this.menuOpen.set('plugin');
  }

  protected closeMenu(): void {
    this.menuOpen.set(null);
    this.pluginIndex.set(-1);
    this.tableHover.set(null);
  }

  /** Anchors the menu just below the trigger button. The 200px clamp keeps
      a near-right-edge button from pushing the menu out of the window. */
  private anchorFrom(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuPos.set({
      x: Math.max(0, Math.round(Math.min(rect.left, window.innerWidth - 200))),
      y: Math.round(rect.bottom + 4),
    });
  }

  /** True for every cell up to and including the hovered one (row AND col). */
  protected isCellOn(r: number, c: number): boolean {
    const h = this.tableHover();
    return h !== null && r <= h.r && c <= h.c;
  }

  protected chooseImages(): void {
    this.closeMenu();
    this.imageInput()?.nativeElement.click();
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
    this.closeMenu();
    if (button.commandId !== undefined) {
      this.keys.run(button.commandId);
    } else {
      button.run?.();
    }
    this.done.emit();
  }

  /** A plugin popover dismissed itself (a pick, Escape). */
  private finish(): void {
    this.closeMenu();
    this.done.emit();
  }

  protected togglePin(): void {
    this.closeMenu();
    this.pinToggle.emit();
  }

  protected emit(action: ToolbarAction): void {
    this.closeMenu();
    this.action.emit(action);
  }

  /** "Emoji…": close the menu, hand the pick to the surface. */
  protected pickEmoji(): void {
    this.closeMenu();
    this.emojiPick.emit();
  }

  /** "Clear formatting": close the menu, hand the stroke to the surface. */
  protected erase(): void {
    this.closeMenu();
    this.clearFormatting.emit();
  }
}
