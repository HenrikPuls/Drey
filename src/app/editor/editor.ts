import {
  AfterViewInit,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EditorView } from '@codemirror/view';
import { ActionsService } from '../llm';
import { CLASSIC_ENTRY_PATTERN, editorFontFamilyStacks } from '../../../shared/app-config';
import { EditorService, EditorViewMode, NewEntryRequest } from '../services/editor.service';
import { EditorZoomService } from '../services/editor-zoom.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { PaneService } from '../panes/pane.service';
import { SettingsService } from '../services/settings.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { TagSearchService } from '../tags';
import { Icon } from '../icons/icon';
import { resolveVaultLinkPath } from './link-open';
import { MarkdownSurface } from './markdown-surface/markdown-surface';

/**
 * One pane's document editor (ADR-0037): hosts one `MarkdownSurface` (the
 * shared CodeMirror component, also used by the capture input -- ADR-0009)
 * bound to *this pane's* shown document (`shownPath` / `shownDoc`, from
 * `PaneService.pane(paneId)`), and owns everything document-shaped around
 * it: syncing that document's buffer, the `⋯` mode menu, and quick-capture
 * / capture-input entries. Save (`Ctrl+S` / `Ctrl+Shift+S`) is an app-wide
 * command (`App`) that acts on the *focused* pane -- see `EditorService`'s
 * doc comment.
 *
 * Global per-id requests (`newEntryRequest`, `insertRequest`) are gated on
 * `PaneService.focusedId() === paneId()`: every open pane's `Editor` sees
 * the same request, but only the focused one should act on it, or a quick
 * capture / assistant insert would land in every pane at once.
 * `revealRequest` needs no such gate -- it is scoped by path instead
 * (`loadedPath === request.path`), and a path lives in exactly one pane.
 *
 * Two modes over the one always-visible surface, switched from the `⋯`
 * menu: **live** (Live Preview decorations) and **source** (raw Markdown,
 * the escape hatch). The mode travels through the surface's `mode` input.
 *
 * Multi-tab (ADR-0003): one view per pane; a tab switch within the pane
 * swaps its document via `loadActiveDoc()`. Undo history does not survive
 * a tab switch.
 */
@Component({
  selector: 'app-editor',
  templateUrl: './editor.html',
  styleUrl: './editor.css',
  imports: [Icon, MarkdownSurface, OverlayGuardDirective],
  host: {
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
  private readonly panes = inject(PaneService);
  private readonly spellcheck = inject(SpellcheckService);
  private readonly tagSearch = inject(TagSearchService);

  /** Which pane this editor belongs to (ADR-0037) -- set once by `PaneLeaf`. */
  readonly paneId = input.required<string>();

  /** The vault-relative path *this pane* currently shows (its own active tab). */
  protected readonly shownPath = computed<string | null>(
    () => this.panes.pane(this.paneId())?.active ?? null,
  );
  /** The `OpenDoc` for `shownPath`, or null. */
  protected readonly shownDoc = computed(() => this.editor.docFor(this.shownPath()));

  /**
   * Passed to the surface: a `Ctrl`/`Cmd`-click on a `#tag` pill replaces
   * the sidebar search query with that tag and runs it. An arrow function
   * so it keeps its `this` when the extension calls it.
   */
  protected readonly activateTag = (tag: string): void => this.tagSearch.searchTag(tag);

  /**
   * Passed to the surface: a `Ctrl`/`Cmd`-click on a Markdown link. Web /
   * mail targets open in the OS default handler; a vault-relative path
   * opens as a tab. An arrow function so it keeps `this`.
   */
  protected readonly activateLink = (href: string): void => {
    const raw = href.trim();
    if (/^(https?:|mailto:)/i.test(raw)) {
      void window.dreyApi.openExternal(raw);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      return; // some other scheme -- leave it alone
    }
    const target = resolveVaultLinkPath(this.shownPath(), raw);
    if (target) {
      void this.editor.openFile(target);
    }
  };

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
  /** Last `insertRequest` id this component has acted on. */
  private handledInsertRequest = 0;
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

  private get view(): EditorView | undefined {
    return this.surfaceReady ? this.surface().view : undefined;
  }

  /** Whether this pane currently has focus -- gates the global per-id requests below. */
  private get isFocusedPane(): boolean {
    return this.panes.focusedId() === this.paneId();
  }

  /** Previous `isFocusedPane` value, for the "pull the caret in on focus gain" effect. */
  private wasFocused = false;

  constructor() {
    // Load this pane's shown document into CodeMirror whenever it changes
    // (switching tabs keeps each buffer's unsaved text) or its saved
    // content changes (right after a save). Both signals are read so the
    // effect subscribes; the guard in loadActiveDoc() makes the common
    // no-op case cheap and prevents an echo when the user is typing.
    effect(() => {
      this.shownPath();
      this.shownDoc()?.savedContent;
      this.loadActiveDoc();
    });

    // New-entry requests: the quick-capture hotkey (no text) and the bottom
    // capture input (with text). Only the focused pane acts -- every open
    // pane sees the same request id. The just-mounting case is picked up in
    // ngAfterViewInit (the view may not exist yet when a request lands).
    effect(() => {
      const request = this.editor.newEntryRequest();
      if (this.view && this.isFocusedPane) {
        this.applyNewEntryRequest(request);
      }
    });

    // The note assistant's "insert into note" arrow: drop the card text in
    // at the caret (replacing any selection). Focused pane only, same as above.
    effect(() => {
      const request = this.editor.insertRequest();
      if (this.view && this.isFocusedPane) {
        this.applyInsertRequest(request);
      }
    });

    // Reveal requests from the tag-search panel: jump the caret to a line
    // once that file's buffer is actually in the view. Scoped by path, not
    // focus -- a path lives in exactly one pane, so exactly one `Editor`
    // instance's `loadedPath` will ever match.
    effect(() => {
      const request = this.editor.revealRequest();
      this.shownDoc()?.bufferContent; // re-run after the load settles
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

    // When this pane gains focus (F6 / the Split command / a click on
    // another pane) pull the caret into its editor -- otherwise keystrokes
    // still go to the pane you just left. Skipped on the first run and
    // while there is only one pane, so app-start focus is unchanged.
    effect(() => {
      const focused = this.isFocusedPane;
      const multiPane = this.panes.paneIds().length > 1;
      if (focused && !this.wasFocused && multiPane) {
        this.view?.focus();
      }
      this.wasFocused = focused;
    });
  }

  ngAfterViewInit(): void {
    this.surfaceReady = true;
    this.loadActiveDoc();
    // A request may have arrived while this component was still mounting
    // (hotkey or capture on a not-yet-open file) -- the effect ran with no
    // view. Apply whatever is pending now.
    if (this.isFocusedPane) {
      this.applyNewEntryRequest(this.editor.newEntryRequest());
    }
    // A pane created by "Split right/down" mounts already focused: the
    // focus-gain effect above ran before this view existed, so land the
    // caret here now.
    if (this.isFocusedPane && this.panes.paneIds().length > 1) {
      this.view?.focus();
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
    this.closeMenu();
    this.editor.setViewMode(mode, this.shownPath() ?? undefined);
  }

  /**
   * Runs a manual Action against this pane's open document (ADR-0011).
   * Passes the live CodeMirror text and any selection as context; the
   * outcome goes through the shared confirmation flow in `ActionsService`.
   */
  protected runAction(triggerId: string): void {
    this.closeMenu();
    const view = this.view;
    const path = this.shownPath();
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
      const edit = this.editor.entryDraftEdit(
        view.state.doc.toString(),
        request.draft,
        request.pattern ?? CLASSIC_ENTRY_PATTERN,
      );
      view.dispatch({
        changes: edit,
        selection: { anchor: edit.from + edit.insert.length },
        scrollIntoView: true,
      });
      // `docChanged` has already pushed the new text into the buffer, so
      // the save below writes exactly what was just inserted.
      void this.editor.save({ path: this.shownPath() ?? undefined });
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

  /**
   * Replaces the current selection (or inserts at the caret) with
   * `request.text` and moves the caret past it -- the assistant's
   * insert-into-note action. The buffer's `docChanged` handles the rest
   * (dirty state, save with Ctrl+S); nothing is written automatically.
   */
  private applyInsertRequest(request: { id: number; text: string }): void {
    const view = this.view;
    if (!view || request.id === 0 || request.id === this.handledInsertRequest) {
      return;
    }
    this.handledInsertRequest = request.id;
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: request.text },
      selection: { anchor: range.from + request.text.length },
      scrollIntoView: true,
    });
    view.focus();
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
   * Pushes this pane's shown document's buffer into CodeMirror. Called
   * whenever the shown path changes and after a save. Guarded so that the
   * echo from the surface's docChanged (buffer changes -> effect re-runs)
   * is a no-op, and so switching to a tab whose text CM already shows costs
   * nothing.
   */
  private loadActiveDoc(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const path = this.shownPath();
    const current = view.state.doc.toString();
    const next = this.shownDoc()?.bufferContent ?? '';
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
