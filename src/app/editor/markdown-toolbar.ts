import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import { ToolbarAction } from './toolbar-commands';

/**
 * The formatting bar above the Markdown surface (rendered by the surface
 * itself when its `toolbar` input is on). Pure emitter: every button turns
 * into a `ToolbarAction`, the surface owns the editor and applies it.
 */
@Component({
  selector: 'app-markdown-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <!-- Heading level -->
      <div class="group">
        <button
          type="button"
          class="tb-btn wide"
          title="Heading"
          aria-label="Heading level"
          (click)="menuOpen.set(menuOpen() === 'heading' ? null : 'heading')"
        >
          H1 <span class="chev" aria-hidden="true">&#8250;</span>
        </button>
        @if (menuOpen() === 'heading') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <nav class="menu" role="menu">
            @for (h of headings; track h.level) {
              <button type="button" role="menuitem" (click)="emit({ kind: 'heading', level: h.level })">
                {{ h.label }}
              </button>
            }
          </nav>
        }
      </div>

      <!-- Lists -->
      <div class="group">
        <button
          type="button"
          class="tb-btn wide"
          title="List"
          aria-label="List style"
          (click)="menuOpen.set(menuOpen() === 'list' ? null : 'list')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <path d="M5.5 3.5h8M5.5 8h8M5.5 12.5h8" stroke-linecap="round" />
            <circle cx="2.5" cy="3.5" r="1" fill="currentColor" stroke="none" />
            <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
            <circle cx="2.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
          </svg>
          <span class="chev" aria-hidden="true">&#8250;</span>
        </button>
        @if (menuOpen() === 'list') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <nav class="menu" role="menu">
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

      <span class="divider" aria-hidden="true"></span>

      <button
        type="button"
        class="tb-btn bold"
        title="Bold"
        aria-label="Bold"
        (click)="emit({ kind: 'wrap', marker: '**' })"
      >
        B
      </button>
      <button
        type="button"
        class="tb-btn italic"
        title="Italic"
        aria-label="Italic"
        (click)="emit({ kind: 'wrap', marker: '*' })"
      >
        I
      </button>
      <button
        type="button"
        class="tb-btn strike"
        title="Strikethrough"
        aria-label="Strikethrough"
        (click)="emit({ kind: 'wrap', marker: '~~' })"
      >
        S
      </button>

      <span class="divider" aria-hidden="true"></span>

      <button
        type="button"
        class="tb-btn"
        title="Link"
        aria-label="Insert link"
        (click)="emit({ kind: 'link' })"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6.5 9.5 9.5 6.5" />
          <path d="M5.2 7.2 3.9 8.5a2.2 2.2 0 0 0 3.1 3.1l1.3-1.3" />
          <path d="M10.8 8.8l1.3-1.3a2.2 2.2 0 0 0-3.1-3.1L7.7 5.7" />
        </svg>
      </button>

      @if (imagesEnabled()) {
        <button
          type="button"
          class="tb-btn"
          title="Image"
          aria-label="Insert image"
          (click)="imageInput.click()"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <circle cx="5.8" cy="6.5" r="1.2" />
            <path d="M2.5 12 6.5 8.5l2.5 2.2 2-1.7 2.5 2.5" />
          </svg>
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
          class="tb-btn wide"
          title="Table"
          aria-label="Insert table"
          (click)="toggleTableMenu()"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <path d="M2 6.5h12M6 6.5V13M10 6.5V13" />
          </svg>
          <span class="chev" aria-hidden="true">&#8250;</span>
        </button>
        @if (menuOpen() === 'table') {
          <div class="backdrop" (click)="menuOpen.set(null)"></div>
          <div class="menu table-menu">
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
    .tb-btn {
      min-width: 26px;
      height: 26px;
      padding: 0 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      border: none;
      border-radius: var(--radius-xs);
      background: none;
      color: var(--text-3);
      font: 600 12.5px/1 var(--font-sans);
      cursor: pointer;
      transition:
        background 120ms ease,
        color 120ms ease;
    }
    .tb-btn:hover {
      background: var(--hover-bg);
      color: var(--text-2);
    }
    .tb-btn.wide {
      padding: 0 6px;
    }
    .tb-btn.bold {
      font-weight: 700;
    }
    .tb-btn.italic {
      font-style: italic;
      font-family: Georgia, serif;
      font-weight: 500;
    }
    .tb-btn.strike {
      text-decoration: line-through;
    }
    .chev {
      font-size: 10px;
      margin-left: 1px;
      color: var(--text-4);
    }
    .divider {
      width: 1px;
      height: 16px;
      margin: 0 4px;
      background: var(--border-strong);
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 45;
    }
    .menu {
      position: absolute;
      left: 0;
      top: 30px;
      z-index: 46;
      display: flex;
      flex-direction: column;
      min-width: 140px;
      padding: 6px;
      background: var(--bg-input);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      box-shadow: 0 6px 18px rgb(0 0 0 / 25%);
    }
    .menu button {
      padding: 5px 8px;
      border: none;
      border-radius: var(--radius-xs);
      background: none;
      color: var(--text-2);
      font: 400 12.5px/1.3 var(--font-sans);
      text-align: left;
      cursor: pointer;
    }
    .menu button:hover {
      background: var(--hover-bg);
      color: var(--text-1);
    }
    .table-menu {
      min-width: 0;
      gap: 6px;
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

  protected readonly menuOpen = signal<'heading' | 'list' | 'table' | null>(null);

  protected readonly headings: { level: 0 | 1 | 2 | 3; label: string }[] = [
    { level: 0, label: 'Body text' },
    { level: 1, label: 'Heading 1' },
    { level: 2, label: 'Heading 2' },
    { level: 3, label: 'Heading 3' },
  ];

  /** The table picker: a 5x5 grid of cells, hover-selected like in Word. */
  protected readonly gridRange = [0, 1, 2, 3, 4];

  protected readonly tableHover = signal<{ r: number; c: number } | null>(null);

  protected toggleTableMenu(): void {
    if (this.menuOpen() === 'table') {
      this.menuOpen.set(null);
      return;
    }
    this.tableHover.set(null);
    this.menuOpen.set('table');
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

  protected emit(action: ToolbarAction): void {
    this.menuOpen.set(null);
    this.tableHover.set(null);
    this.action.emit(action);
  }
}
