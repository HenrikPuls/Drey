import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { AssistantService } from './assistant.service';
import { EditorService } from '../services/editor.service';
import { LayoutService } from '../services/layout.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { Icon } from '../icons/icon';

/**
 * The note assistant panel on the right: the automatic summary of the open
 * note, the question/answer thread that follows it, and the composer.
 *
 * The panel is per-note. Its "Automatic summary" switch starts from the
 * global default (Settings -> Assistant) and overrides it for the current
 * note only -- `AssistantService` holds that rule; this component only
 * renders it.
 *
 * The question composer is the shared `MarkdownSurface` in compact mode --
 * the same editor component as the document and the entry drawer, so the
 * inline spellchecker (nspell + click-to-correct popup, ADR-0013) behaves
 * identically here. There is no second spellchecker anywhere in the app.
 */
@Component({
  selector: 'app-note-assistant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MarkdownSurface],
  templateUrl: './note-assistant.html',
  styleUrl: './note-assistant.css',
})
export class NoteAssistant {
  protected readonly assistant = inject(AssistantService);
  protected readonly editor = inject(EditorService);
  protected readonly layout = inject(LayoutService);
  private readonly spellcheck = inject(SpellcheckService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly composer = viewChild(MarkdownSurface);

  /** True while the thread|composer divider is being dragged. */
  private draggingComposer = false;

  /** Ungated source: the composer is checked from the first word, like the drawer. */
  protected readonly spellcheckSource = this.spellcheck.makeSource();

  constructor() {
    // The checker only re-runs on a text change, so toggling spelling (or
    // switching dictionary) in Settings would otherwise leave the current
    // text judged by the old setting until the next keystroke.
    effect(() => {
      this.spellcheck.enabled();
      this.spellcheck.language();
      this.composer()?.recheckSpelling();
    });
  }

  /** Card whose inline "restart from here?" confirm strip is showing. */
  protected readonly confirmingRestart = signal<string | null>(null);
  /** Card whose "Copy" button just copied, for the brief "Copied" label. */
  protected readonly copiedCard = signal<string | null>(null);

  /** `took 8s` for a finished card, or null when nothing was generated. */
  protected took(durationMs: number | undefined): string | null {
    return this.assistant.took(durationMs);
  }

  protected label(role: string): string {
    return role === 'summary' ? 'SUMMARY' : role === 'question' ? 'YOU' : 'ANSWER';
  }

  /**
   * Enter sends, Shift+Enter breaks the line -- the compact `MarkdownSurface`
   * emits `submitRequested` for that (its own keymap), so this is just the
   * handler for that event.
   */
  protected async send(): Promise<void> {
    const surface = this.composer();
    if (!surface) {
      return;
    }
    const question = surface.getContent().trim();
    if (question === '') {
      return;
    }
    surface.setContent('');
    if (!(await this.assistant.ask(question))) {
      surface.setContent(question); // keep what the user typed when it failed
    }
  }

  /**
   * The thread|composer divider. Same native-pointer-capture drag as the
   * shell's three handles (`App`): capture on the handle keeps the drag
   * alive outside the 1px strip, and the moved-to height is pushed into
   * `LayoutService`, which clamps and persists it. The composer is flush
   * with the panel's bottom edge, so its height is the gap between the
   * pointer and that edge.
   */
  protected startComposerDrag(event: PointerEvent): void {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.draggingComposer = true;
    document.body.style.userSelect = 'none';
  }

  @HostListener('pointermove', ['$event'])
  protected onPointerMove(event: PointerEvent): void {
    if (!this.draggingComposer) {
      return;
    }
    const bottom = this.host.nativeElement.getBoundingClientRect().bottom;
    this.layout.setAssistantComposerHeight(bottom - event.clientY);
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  protected onPointerUp(): void {
    if (this.draggingComposer) {
      this.draggingComposer = false;
      document.body.style.userSelect = '';
    }
  }

  /** First click on "Restart from here" -- shows the confirm strip. */
  protected armRestart(cardId: string): void {
    this.confirmingRestart.set(cardId);
  }

  protected cancelRestart(): void {
    this.confirmingRestart.set(null);
  }

  /** Confirmed "Restart from here": rewind the thread, refill the composer. */
  protected async restartFrom(cardId: string): Promise<void> {
    this.confirmingRestart.set(null);
    const question = await this.assistant.restartFrom(cardId);
    const surface = this.composer();
    if (surface && question !== null) {
      surface.setContent(question);
      surface.focus();
    }
  }

  protected async copyCard(cardId: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copiedCard.set(cardId);
      setTimeout(() => {
        if (this.copiedCard() === cardId) {
          this.copiedCard.set(null);
        }
      }, 1200);
    } catch {
      // Clipboard access denied -- nothing useful to do from the panel.
    }
  }
}
