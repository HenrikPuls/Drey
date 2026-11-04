import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { MarkdownViewHandle } from '@markdown-surface/create-view';
import type { ToolbarAction } from '@markdown-surface/toolbar-commands';

import { MD_MODES, MD_MODE_LABEL, deviceStorage, storedMode, storeMode, type MdMode } from './mode';

/** One formatting-strip button: a glyph, its accessible name and the action. */
export interface MdStripButton {
  readonly glyph: string;
  readonly label: string;
  readonly action: ToolbarAction;
}

export const MD_STRIP: readonly MdStripButton[] = [
  { glyph: 'B', label: 'Bold', action: { kind: 'wrap', marker: '**' } },
  { glyph: 'I', label: 'Italic', action: { kind: 'wrap', marker: '*' } },
  { glyph: 'H', label: 'Heading', action: { kind: 'heading', level: 2 } },
  { glyph: '•', label: 'Bullet list', action: { kind: 'list', style: 'bullet' } },
  { glyph: '☑', label: 'Task list', action: { kind: 'list', style: 'task' } },
  { glyph: '</>', label: 'Code block', action: { kind: 'fence' } },
  { glyph: '❝', label: 'Quote', action: { kind: 'quote' } },
  { glyph: '↗', label: 'Link', action: { kind: 'link' } },
];

/**
 * The Markdown surface of Mission Control (E12-6, milestone 133): the SAME
 * CodeMirror engine as the Drey desktop editor — the extended dialect
 * (tables, task lists, callouts, math, footnotes, emoji, highlight, fenced
 * code with syntax colours, mermaid) — in three modes: Live Preview, View
 * (read-only rendered) and Source. `defaultMode` is View wherever a result
 * is presented and Live Preview where the owner is writing; the pick is
 * remembered per `surface` key on this device.
 *
 * The CodeMirror chunk loads on first mount (`import()` — its own lazy
 * chunk), so the app's first paint never pays for it; until it arrives the
 * text shows as plain wrapped text. The surface is a view onto `text`: an
 * edit (only when `editable`) leaves through `textChange`, the owner feeds
 * the new text back.
 */
@Component({
  selector: 'mc-markdown',
  templateUrl: './markdown.html',
  styleUrl: './markdown.css',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Markdown implements OnDestroy {
  readonly text = input.required<string>();
  /** The persistence key: one per place text is shown (`ticket`, `plan`, …). */
  readonly surface = input.required<string>();
  readonly defaultMode = input<MdMode>('view');
  readonly editable = input(false);
  /** The accessible name of the surface and its controls. */
  readonly label = input('Markdown');
  readonly textChange = output<string>();
  readonly linkOpened = output<string>();

  protected readonly modes = MD_MODES;
  protected readonly modeLabel = MD_MODE_LABEL;
  protected readonly strip = MD_STRIP;
  protected readonly mode = signal<MdMode>('view');
  protected readonly ready = signal(false);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private handle: MarkdownViewHandle | null = null;
  private destroyed = false;
  private modeResolved = false;
  private mounting = false;

  constructor() {
    effect(() => {
      // The first pass resolves the remembered mode for this surface; the
      // surface key and default never change per instance.
      const surface = this.surface();
      const fallback = this.defaultMode();
      if (!this.modeResolved) {
        this.modeResolved = true;
        this.mode.set(storedMode(deviceStorage(), surface, fallback));
      }
      void this.mount();
    });
    effect(() => {
      const text = this.text();
      this.handle?.setDoc(text);
    });
    effect(() => {
      const mode = this.mode();
      const editable = this.editable();
      this.handle?.setEditable(editable);
      this.handle?.setMode(mode);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.handle?.destroy();
    this.handle = null;
  }

  protected pick(mode: MdMode): void {
    this.mode.set(mode);
    storeMode(deviceStorage(), this.surface(), mode);
  }

  protected format(action: ToolbarAction): void {
    this.handle?.applyAction(action);
  }

  private async mount(): Promise<void> {
    if (this.handle !== null || this.mounting) {
      return;
    }
    this.mounting = true;
    try {
      const { createMarkdownView } = await import('@markdown-surface/create-view');
      if (this.destroyed) {
        return;
      }
      const [text, mode, editable] = untracked(() => [this.text(), this.mode(), this.editable()] as const);
      this.handle = createMarkdownView({
        parent: this.host().nativeElement,
        doc: text,
        mode,
        editable,
        onChange: (next) => this.textChange.emit(next),
        onOpenLink: (href) => this.linkOpened.emit(href),
      });
      this.ready.set(true);
    } catch {
      // The chunk failed to load (offline mid-session): the plain text stays.
    } finally {
      this.mounting = false;
    }
  }
}
