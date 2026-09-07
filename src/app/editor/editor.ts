import {
  AfterViewInit,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { EditorView } from '@codemirror/view';
import { ActionsService } from '../services/actions.service';
import { AssistantService } from '../services/assistant.service';
import { editorFontFamilyStacks } from '../../../shared/app-config';
import { EditorService, EditorViewMode, NewEntryRequest } from '../services/editor.service';
import { EditorZoomService } from '../services/editor-zoom.service';
import { SettingsService } from '../services/settings.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { Icon } from '../icons/icon';
import { MarkdownSurface } from './markdown-surface/markdown-surface';

/**
 * The full-page document editor: hosts one `MarkdownSurface` (the shared
 * CodeMirror component, also used by the capture input -- ADR-0009) and owns
 * everything document-shaped around it: syncing the active tab's buffer,
 * the `⋯` mode menu, Ctrl+S, and quick-capture / capture-input entries.
 *
 * Two modes over the one always-visible surface, switched from the `⋯`
 * menu: **live** (Live Preview decorations) and **source** (raw Markdown,
 * the escape hatch). The mode travels through the surface's `mode` input.
 *
 * Multi-tab (ADR-0003): one view; a tab switch swaps its document via
 * `loadActiveDoc()`. Undo history does not survive a tab switch.
 */
@Component({
  selector: 'app-editor',
  templateUrl: './editor.html',
  styleUrl: './editor.css',
  imports: [Icon, MarkdownSurface],
  host: {
    '(keydown)': 'onKeydown($event)',
    '(wheel)': 'onWheel($event)',
    // Editor content zoom (Ctrl +/-/0, ADR-0015). The keydown is bound on
    // `document` so it works while any pane has focus, as long as a
    // document is open; the CSS var is read by `editor-theme.ts`'s
    // `.cm-scroller` rule and only reaches this subtree, so the entry
    // drawer's surface stays at its normal size.
    '(document:keydown)': 'onDocumentKeydown($event)',
    '[style.--drey-editor-scale]': 'zoom.scale()',
    // Editor typeface (Settings -> Appearance). Re-points the two font vars
    // on this host only, so the document editor's body + headings follow the
    // choice while the sidebar, drawer and assistant panel stay on the app
    // defaults. `editor-theme.ts` reads `--drey-heading-font` for headings.
    '[style.--font-sans]': 'fontStacks().body',
    '[style.--drey-heading-font]': 'fontStacks().heading',
    '(document:keydown.escape)': 'closeMenu()',
  },
})
export class Editor implements AfterViewInit {
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  protected readonly zoom = inject(EditorZoomService);
  protected readonly actions = inject(ActionsService);
  protected readonly assistant = inject(AssistantService);
  private readonly spellcheck = inject(SpellcheckService);

  /**
   * The document is spellchecked as you type, like the entry drawer. Past
   * `FULL_SCAN_LIMIT` the extension follows the viewport instead of
   * scanning the whole note on every pause.
   */
  protected readonly spellcheckSource = this.spellcheck.makeSource();

  private readonly surface = viewChild.required(MarkdownSurface);
  private readonly moreBtn = viewChild.required<ElementRef<HTMLButtonElement>>('moreBtn');

  /** Last `revealRequest` id this component has acted on. */
  private handledRevealRequest = 0;

  /** Last `newEntryRequest` id this component has acted on. */
  private handledEntryRequest = 0;
  /** Path whose text CodeMirror currently holds -- distinguishes a tab switch from an in-place reload. */
  private loadedPath: string | null = null;
  /**
   * Frontmatter fold state per document path (ADR-0009): the single reused
   * CodeMirror view can't hold per-tab state itself, so a tab switch saves
   * the outgoing tab's state here and replays the incoming tab's.
   */
  private readonly frontmatterFoldByPath = new Map<string, boolean>();
  /** Set once the child surface's view exists (its ngAfterViewInit runs before ours). */
  private surfaceReady = false;

  /** `⋯` mode menu: open state and viewport-anchored position. */
  protected readonly menuOpen = signal(false);
  protected readonly menuPos = signal({ x: 0, y: 0 });

  /** `--font-sans` / `--drey-heading-font` overrides for the chosen editor typeface. */
  protected readonly fontStacks = computed(() =>
    editorFontFamilyStacks(this.settings.editorFontFamily()),
  );

  protected readonly wordCount = computed(() => {
    const words = this.editor.bufferContent().trim().split(/\s+/).filter(Boolean);
    return words.length;
  });

  private get view(): EditorView | undefined {
    return this.surfaceReady ? this.surface().view : undefined;
  }

  constructor() {
    // Load the active tab's buffer into CodeMirror whenever the active tab
    // changes (switching tabs keeps each buffer's unsaved text) or its
    // saved content changes (right after a save). Both signals are read so
    // the effect subscribes; the guard in loadActiveDoc() makes the common
    // no-op case cheap and prevents an echo when the user is typing.
    effect(() => {
      this.editor.activePath();
      this.editor.savedContent();
      this.loadActiveDoc();
    });

    // New-entry requests: the quick-capture hotkey (no text) and the bottom
    // capture input (with text). The just-mounting case is picked up in
    // ngAfterViewInit (the view may not exist yet when a request lands).
    effect(() => {
      const request = this.editor.newEntryRequest();
      if (this.view) {
        this.applyNewEntryRequest(request);
      }
    });

    // Reveal requests from the tag-search panel: jump the caret to a line
    // once that file's buffer is actually in the view.
    effect(() => {
      const request = this.editor.revealRequest();
      this.editor.bufferContent(); // re-run after the load settles
      if (this.view && this.loadedPath === request.path) {
        this.applyRevealRequest(request);
      }
    });

    // Re-judge the open document when the spelling settings change; the
    // extension itself only reacts to text edits.
    effect(() => {
      this.spellcheck.enabled();
      this.spellcheck.language();
      if (this.surfaceReady) {
        this.surface().recheckSpelling();
      }
    });
  }

  ngAfterViewInit(): void {
    this.surfaceReady = true;
    this.loadActiveDoc();
    // A request may have arrived while this component was still mounting
    // (hotkey or capture on a not-yet-open file) -- the effect ran with no
    // view. Apply whatever is pending now.
    this.applyNewEntryRequest(this.editor.newEntryRequest());
  }

  protected async onKeydown(event: KeyboardEvent): Promise<void> {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      await this.editor.save();
    }
  }

  /** Ctrl +/-/0 zoom the editor content only (ADR-0015), from any pane. */
  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (this.zoom.handleKey(event)) {
      event.preventDefault();
    }
  }

  /** Ctrl/Cmd + mouse wheel steps the editor content zoom (ADR-0015). */
  protected onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoom.stepIn();
    } else if (event.deltaY > 0) {
      this.zoom.stepOut();
    }
  }

  /** Opens the `⋯` menu anchored under its button, or closes it if already open. */
  protected toggleMenu(): void {
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return;
    }
    const rect = this.moreBtn().nativeElement.getBoundingClientRect();
    this.menuPos.set({ x: Math.round(rect.right - 148), y: Math.round(rect.bottom + 4) });
    this.menuOpen.set(true);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected chooseMode(mode: EditorViewMode): void {
    this.editor.setViewMode(mode);
    this.closeMenu();
  }

  /**
   * Runs a manual Action against the open document (ADR-0011). Passes the
   * live CodeMirror text and any selection as context; the outcome goes
   * through the shared confirmation flow in `ActionsService`.
   */
  protected runAction(triggerId: string): void {
    this.closeMenu();
    const view = this.view;
    const path = this.editor.openPath();
    if (!view || path === null) {
      return;
    }
    const range = view.state.selection.main;
    void this.actions.run(triggerId, {
      path,
      body: view.state.doc.toString(),
      selection: range.empty ? undefined : view.state.sliceDoc(range.from, range.to),
    });
  }

  /**
   * Starts a new daily entry at the end of the document, unless `request`
   * has already been handled. Computes the heading via
   * `EditorService.newDailyEntryEdit` against live CM state; a request
   * carrying `text` appends that text under the heading -- reusing an empty
   * trailing `## HH:mm` heading instead of stacking a second one. The
   * hotkey flow (no text) also moves focus into the editor; a capture
   * leaves focus where the user is typing.
   *
   * A request carrying a `draft` comes from the entry drawer and takes the
   * `shared/entry-compose.ts` path instead: a complete
   * `## HH:mm — <Thema>` block, saved right away so its `#tag`s reach
   * their master documents through the save pipeline.
   */
  private applyNewEntryRequest(request: NewEntryRequest): void {
    const view = this.view;
    if (!view || request.id === 0 || request.id === this.handledEntryRequest) {
      return;
    }
    this.handledEntryRequest = request.id;

    if (request.draft) {
      const edit = this.editor.entryDraftEdit(view.state.doc.toString(), request.draft);
      view.dispatch({
        changes: edit,
        selection: { anchor: edit.from + edit.insert.length },
        scrollIntoView: true,
      });
      // `docChanged` has already pushed the new text into the buffer, so
      // the save below writes exactly what was just inserted.
      void this.editor.save();
      return;
    }

    const docText = view.state.doc.toString();
    const edit = this.editor.newDailyEntryEdit(docText);
    const extra = request.text ? `${request.text.replace(/\s+$/, '')}\n` : '';

    if (edit || extra) {
      const at = edit?.at ?? docText.length;
      const heading = edit?.insert ?? (docText.endsWith('\n') || docText === '' ? '' : '\n');
      const insert = heading + extra;
      view.dispatch({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        scrollIntoView: true,
      });
    } else {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
    }
    if (!request.text) {
      view.focus();
    }
  }

  /** Puts the caret at the start of 1-based `line` and scrolls it into view. */
  private applyRevealRequest(request: { id: number; path: string; line: number }): void {
    const view = this.view;
    if (!view || request.id === 0 || request.id === this.handledRevealRequest) {
      return;
    }
    this.handledRevealRequest = request.id;
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(1, request.line), doc.lines);
    const anchor = doc.line(lineNo).from;
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }

  /**
   * Pushes the active tab's buffer into CodeMirror. Called on tab switch
   * and after a save. Guarded so that the echo from the surface's
   * docChanged (buffer changes -> effect re-runs) is a no-op, and so
   * switching to a tab whose text CM already shows costs nothing.
   */
  private loadActiveDoc(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const path = this.editor.activePath();
    const current = view.state.doc.toString();
    const next = this.editor.bufferContent();
    // Same file, new text = an in-place reload (the save pipeline rewrote
    // the frontmatter). Keep the caret roughly where it was instead of
    // snapping to the top; a tab switch still lands at offset 0.
    const samePath = path === this.loadedPath;

    if (!samePath && this.loadedPath !== null) {
      // Leaving a tab: remember whether its frontmatter was expanded.
      this.frontmatterFoldByPath.set(this.loadedPath, this.surface().frontmatterExpanded());
    }

    if (next !== current) {
      const prevHead = view.state.selection.main.head;
      this.surface().setContent(next, samePath ? prevHead : 0);
    }
    this.loadedPath = path;

    if (!samePath) {
      // Entering a tab: replay its remembered fold state (collapsed by default).
      this.surface().setFrontmatterExpanded(
        path !== null && this.frontmatterFoldByPath.get(path) === true,
      );
    }
  }
}
