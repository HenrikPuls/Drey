import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EditorView } from '@codemirror/view';
import { editorFontFamilyStacks } from '../../../shared/app-config';
import {
  appendTagsToSection,
  frontmatterEndLine,
  sectionAtLine,
} from '../../../shared/note-sections';
import type { MenuContribution } from '../../../shared/plugin-api/renderer';
import { CaretMemory, EditorService, EditorViewMode, NewEntryRequest } from '../services/editor.service';
import { EditorZoomService } from '../services/editor-zoom.service';
import { HistoryService } from '../history';
import { MenuContributionsService } from '../plugin-host';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { PaneService } from '../panes/pane.service';
import { SettingsService } from '../services/settings.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { Icon } from '../icons/icon';
import { resolveVaultLinkPath } from './link-open';
import { EditorPrefsService } from './editor-prefs.service';
import { WikilinkService } from './wikilinks';
import { MarkdownSurface } from './markdown-surface/markdown-surface';
import { MarkdownToolbar } from './markdown-toolbar';

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
  * Three modes over the one always-visible surface, switched from the `⋯`
  * menu: **live** (Live Preview decorations), **view** (read-only through
  * the same engine, links open on a plain click) and **source** (raw
  * Markdown, the escape hatch). The mode travels through the surface's
  * `mode` input.
 *
 * Multi-tab (ADR-0003): one view per pane; a tab switch within the pane
 * swaps its document via `loadActiveDoc()`. Undo history does not survive
 * a tab switch; the caret does -- it is remembered per doc key for the
 * whole app session (milestone 50, surviving even a clean tab's
 * replacement) and replayed into every fresh state, an explicit reveal
 * (link click, search hit) still winning. Entering a tab also focuses the
 * editor, so typing lands in the document without a click first.
 */
@Component({
  selector: 'app-editor',
  templateUrl: './editor.html',
  styleUrl: './editor.css',
  imports: [Icon, MarkdownSurface, MarkdownToolbar, OverlayGuardDirective],
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
    // This host's open document (vault-relative), for surface-scoped
    // behaviour that keys off the DOM (the context menu's click target,
    // ADR-0050). Removed while no document is shown.
    '[attr.data-drey-doc]': 'shownPath()',
    '(document:keydown.escape)': 'closeMenu()',
  },
})
export class Editor implements AfterViewInit, OnDestroy {
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  protected readonly history = inject(HistoryService);
  protected readonly zoom = inject(EditorZoomService);
  protected readonly menuContributions = inject(MenuContributionsService);
  /** The formatting-toolbar toggle (`⋯` menu, persisted per machine). */
  protected readonly prefs = inject(EditorPrefsService);
  private readonly panes = inject(PaneService);
  private readonly spellcheck = inject(SpellcheckService);
  private readonly wikiLinks = inject(WikilinkService);

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

  /**
   * Passed to the surface: a `Ctrl`/`Cmd`-click on a Markdown link. Web /
   * mail targets open in the OS default handler; a `file:` link opens the
   * document in its own program; a vault-relative path opens as a tab
   * (or, for a document type, in its own program too). An arrow function
   * so it keeps `this`.
   */
  protected readonly activateLink = (href: string): void => {
    const raw = href.trim();
    if (/^(https?:|mailto:)/i.test(raw)) {
      void window.dreyApi.openExternal(raw);
      return;
    }
    if (/^file:/i.test(raw)) {
      // A document linked where it lives, outside the vault (ADR-0066):
      // main opens it in its own program, or says why not.
      window.dreyApi.openLocalDocument(raw).catch((err: unknown) =>
        this.editor.error.set(err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      return; // some other scheme -- leave it alone
    }
    const doc = this.shownDoc();
    const target = resolveVaultLinkPath(doc?.path ?? null, raw);
    if (target) {
      void this.editor.openFile(target, doc?.vaultId ?? undefined);
    }
  };

  /**
   * A `Ctrl`/`Cmd`-click on a `[[wikilink]]` (req-20): resolve against this
   * pane's note -- in ITS vault (ADR-0051) -- sibling-first for ambiguous
   * basenames, open at the `#heading` anchor when given, create the note
   * when nothing resolves (in the linking note's vault). An arrow function
   * so it keeps `this` when the extension calls it.
   */
  protected readonly activateWikilink = (target: string, anchor: string | null): void => {
    void this.wikiLinks.open(
      target,
      anchor,
      this.shownDoc()?.vaultId ?? null,
      this.shownDoc()?.path ?? null,
    );
  };

  /**
   * The document is spellchecked as you type, like the entry drawer. Past
   * `FULL_SCAN_LIMIT` the extension follows the viewport instead of
   * scanning the whole note on every pause.
   */
  protected readonly spellcheckSource = this.spellcheck.makeSource();

  protected readonly surface = viewChild.required(MarkdownSurface);
  private readonly moreBtn = viewChild.required<ElementRef<HTMLButtonElement>>('moreBtn');

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
  /**
   * The surface's CodeMirror view, cached when it appears: `ngOnDestroy`
   * must be able to read its (still queryable) selection without going
   * through the viewChild query, which may already be torn down.
   */
  private currentView: EditorView | undefined;

  /** `⋯` mode menu: open state and viewport-anchored position. */
  protected readonly menuOpen = signal(false);
  protected readonly menuPos = signal({ x: 0, y: 0 });

  /** "Suggest tags" in flight: shows the meta-bar hint and blocks re-entry. */
  protected readonly suggestingTags = signal(false);

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
      if (this.view && this.loadedPath === request.key) {
        this.applyRevealRequest(request);
      }
    });

    // The live-edit lock (ADR-0049): while the assistant edits this pane's
    // document, its surface is non-editable for the user (the model's own
    // buffer pushes keep flowing -- see markdown-surface.setEditable).
    effect(() => this.applyEditLock());

    // Re-judge the open document when the spelling settings change; the
    // extension itself only reacts to text edits.
    effect(() => {
      this.spellcheck.enabled();
      this.spellcheck.language();
      this.spellcheck.autoDetect();
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

  /**
   * Pushes the shown document's live-edit input lock (ADR-0049) onto the
   * surface. Also called once the surface exists -- the effect's first run
   * precedes it.
   */
  private applyEditLock(): void {
    const locked = this.editor.isEditLocked(this.shownPath());
    if (this.surfaceReady) {
      this.surface().setEditable(!locked);
    }
  }

  ngAfterViewInit(): void {
    this.surfaceReady = true;
    this.currentView = this.surface().view;
    this.loadActiveDoc();
    this.applyEditLock();
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

  ngOnDestroy(): void {
    this.cancelScrollRestore();
    // A destroyed pane (closed, docked elsewhere, app teardown) can no
    // longer capture on a tab switch -- record the shown document's
    // viewport so reopening it lands where the user left it (milestone
    // 50). The cached view reference still works even if the surface is
    // already gone; a destroyed CodeMirror view keeps a readable state.
    if (this.currentView && this.loadedPath !== null) {
      this.editor.recordCaret(this.loadedPath, this.viewportMemory(this.currentView));
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

  /** Runs a plugin-contributed menu row; rows carrying a commandId instead of a closure are not expected here. */
  protected runContributedRow(row: MenuContribution): void {
    row.run?.();
  }

  protected chooseMode(mode: EditorViewMode): void {
    this.closeMenu();
    this.editor.setViewMode(mode, this.shownPath() ?? undefined);
  }

  /** `⋯` -> "Formatting toolbar": app-wide, persisted with the editor prefs. */
  protected toggleToolbar(): void {
    this.closeMenu();
    this.prefs.toggleToolbar();
  }

  /**
   * `⋯` -> "Suggest tags" (req-36, the re-homed Autotag): sends the
   * caret's heading section to the base `tags:suggest` backend and appends
   * the returned tags into that section directly -- one undo step, saved
   * immediately -- deduplicated against the tags it already carries. The
   * entry drawer's old Autotag button, whose backend stayed base-owned
   * (ADR-0044 stage 7); failures and empty results surface through the
   * editor's `.err` row.
   */
  protected async suggestTags(): Promise<void> {
    const view = this.view;
    const doc = this.shownDoc();
    if (!view || doc === null || doc.kind !== 'text' || this.suggestingTags()) {
      return;
    }
    const content = view.state.doc.toString();
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    if (line <= frontmatterEndLine(content)) {
      this.editor.error.set('Move the caret into the note body to suggest tags.');
      return;
    }
    const section = sectionAtLine(content, line);
    this.suggestingTags.set(true);
    try {
      const suggested = await window.dreyApi.suggestTags(section.text, `suggest-tags:${doc.key}`);
      const next = appendTagsToSection(content, section.startLine, section.endLine, suggested);
      if (next === content) {
        this.editor.error.set('No new tags — the section already carries the suggestions.');
        return;
      }
      this.editor.updateBuffer(doc.key, next);
      await this.editor.save({ key: doc.key });
    } catch (err) {
      this.editor.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.suggestingTags.set(false);
    }
  }

  /**
   * Starts a new daily entry at the end of the document, unless `request`
   * has already been handled. Computes the heading via
   * `EditorService.newDailyEntryEdit` against live CM state; a request
   * carrying `text` appends that text under the heading -- reusing an empty
   * trailing `## HH:mm` heading instead of stacking a second one. The
   * hotkey flow (no text) also moves focus into the editor; a capture
   * leaves focus where the user is typing.
   */
  private applyNewEntryRequest(request: NewEntryRequest): void {
    const view = this.view;
    // The claim is global (see EditorCommandsService) so a freshly mounted
    // editor can never re-apply a request an earlier instance consumed.
    if (!view || !this.editor.claimNewEntryRequest(request.id)) {
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
    if (!view || !this.editor.claimInsertRequest(request.id)) {
      return;
    }
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: request.text },
      selection: { anchor: range.from + request.text.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  /** Puts the caret at the start of 1-based `line` and scrolls it into view. */
  private applyRevealRequest(request: { id: number; key: string; line: number }): void {
    const view = this.view;
    if (!view || !this.editor.claimRevealRequest(request.id)) {
      return;
    }
    // An explicit jump replaces the remembered viewport wholesale -- a
    // scroll restore scheduled by the load below must not fight it.
    this.cancelScrollRestore();
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(1, request.line), doc.lines);
    const anchor = doc.line(lineNo).from;
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }

  /** The pending scroll-restore animation frame of the chain below. */
  private scrollRestoreFrame: number | null = null;

  /** How many frames the caret measurement may retry before giving up. */
  private static readonly RESTORE_RETRY_FRAMES = 5;

  /**
   * Restores the remembered viewport in animation-frame steps (milestone
   * 50). Frame 1 applies the raw scroll offset -- right after `setState`
   * the scroller still reports the previous document's metrics, and
   * CodeMirror measures the swapped document in its own rAF (registered
   * during `setState`, i.e. before this one), so the clamp runs against
   * settled geometry. Frame 2 RE-ASSERTS the raw offset: focusing the
   * freshly swapped editor makes the BROWSER scroll the caret into view,
   * and that implicit scroll can land after frame 1 -- whatever moved
   * the viewport since, the stored value wins. On top of the re-assert,
   * frame 2 optionally applies the caret-anchored correction: a fresh
   * state's height map is entirely ESTIMATED (`HeightMap.empty`), so the
   * raw pixel offset alone lands a few lines off in content space;
   * measuring the caret's rendered position on both ends cancels the
   * estimates out. The correction is a refinement, gated on being safely
   * measurable (`caretRel` captured, the caret inside `visibleRanges` --
   * `coordsAtPos` misbehaves off-render -- and a sub-viewport delta);
   * every failure degrades to the raw offset, never to a
   * scroll-to-caret. The chain is cancelled by a reveal
   * ({@link applyRevealRequest}) and by the next restore.
   */
  private scheduleScrollRestore(memory: CaretMemory): void {
    this.cancelScrollRestore();
    this.scrollRestoreFrame = requestAnimationFrame(() => this.applyScrollRestore(memory, 1));
  }

  private applyScrollRestore(memory: CaretMemory, frame: number): void {
    this.scrollRestoreFrame = null;
    const view = this.currentView;
    if (!view) {
      return;
    }
    const dom = view.scrollDOM;
    const clamp = (value: number): number =>
      Math.max(0, Math.min(value, dom.scrollHeight - dom.clientHeight));
    if (frame === 1) {
      dom.scrollTop = clamp(memory.scrollTop);
      this.scrollRestoreFrame = requestAnimationFrame(() => this.applyScrollRestore(memory, 2));
      return;
    }
    // The re-assert: undo any scroll that happened since frame 1 (the
    // browser's focus-scroll to the caret above all) and make CodeMirror
    // render around the remembered offset.
    dom.scrollTop = clamp(memory.scrollTop);
    if (memory.caretRel === undefined) {
      return; // nothing to anchor to -- the raw offset stands
    }
    const head = view.state.selection.main.head;
    const rendered = view.visibleRanges.some((range) => head >= range.from && head <= range.to);
    const coords = rendered ? this.caretCoords(view, head) : null;
    if (coords === null) {
      // Not rendered yet -- one more frame may see it; the re-asserted
      // raw offset stands meanwhile.
      if (frame < Editor.RESTORE_RETRY_FRAMES) {
        this.scrollRestoreFrame = requestAnimationFrame(() =>
          this.applyScrollRestore(memory, frame + 1),
        );
      }
      return;
    }
    const delta = coords.top - dom.getBoundingClientRect().top - memory.caretRel;
    if (Math.abs(delta) > dom.clientHeight) {
      return; // a delta that size is a bad measurement, not drift
    }
    dom.scrollTop = clamp(dom.scrollTop + delta);
  }

  /** `coordsAtPos` that never throws (a headless DOM lacks layout APIs). */
  private caretCoords(view: EditorView, pos: number): { top: number } | null {
    try {
      return view.coordsAtPos(pos);
    } catch {
      return null;
    }
  }

  private cancelScrollRestore(): void {
    if (this.scrollRestoreFrame !== null) {
      cancelAnimationFrame(this.scrollRestoreFrame);
      this.scrollRestoreFrame = null;
    }
  }

  /**
   * The leaving document's viewport (milestone 50): caret head, raw scroll
   * offset, and -- when the caret is rendered -- its offset from the
   * viewport top, which is what makes the restore exact (see
   * {@link applyScrollRestore}).
   */
  private viewportMemory(view: EditorView): CaretMemory {
    const head = view.state.selection.main.head;
    const scrollTop = view.scrollDOM.scrollTop;
    const coords = this.caretCoords(view, head);
    if (coords === null) {
      return { head, scrollTop };
    }
    const rel = coords.top - view.scrollDOM.getBoundingClientRect().top;
    return Number.isFinite(rel) ? { head, scrollTop, caretRel: rel } : { head, scrollTop };
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
    // snapping to the top; a tab switch restores the remembered caret.
    const samePath = path === this.loadedPath;
    // A real tab switch inside a live pane (not the pane's first load) --
    // drives both the leave-capture below and the focus on entering.
    const leavingPath = !samePath && this.loadedPath !== null ? this.loadedPath : null;

    if (leavingPath !== null) {
      // Leaving a tab: remember whether its frontmatter was expanded and
      // its viewport (milestone 50) -- both replayed on the way back in.
      // The view still holds the leaving document's state here.
      this.frontmatterFoldByPath.set(leavingPath, this.surface().frontmatterExpanded());
      this.editor.recordCaret(leavingPath, this.viewportMemory(view));
    }

    if (next !== current) {
      if (samePath) {
        // Same file, new text = an in-place reload (the save pipeline
        // rewrote the frontmatter -- every save of a frontmattered note
        // bumps `updated:`, a watcher reload, a live-edit push): a plain
        // undoable edit that keeps the caret where it was. The viewport
        // must survive it too (milestone 50): the full replace discards
        // CodeMirror's height map, and holding the numeric scroll offset
        // alone only works while the estimates hold -- with block widgets
        // they collapse, the browser clamps the scroller, and the view
        // ends up near the top. Capture the user's viewport before the
        // swap and replay it through the same restore chain a tab switch
        // uses -- unless the view is pinned to the bottom, where
        // stick-to-bottom stays the right destination (the streamed
        // search summary follows the tail).
        const prevHead = view.state.selection.main.head;
        const pinned = this.surface().pinnedToBottom();
        const memory = this.viewportMemory(view);
        this.surface().setContent(next, prevHead);
        if (!pinned) {
          this.scheduleScrollRestore(memory);
        }
      } else {
        // First load / tab switch: a fresh state. The load must not be an
        // undo event -- a second Ctrl+Z in a freshly opened tab used to
        // roll the load back and wipe the document -- and undo history
        // does not survive a tab switch anyway (see this file's header).
        // The viewport, however, is remembered per doc key for the whole
        // app session (milestone 50) -- including a clean tab that was
        // replaced and reopened, and including a caret that never left
        // offset 0 (scroll-only browsing): whenever a memory EXISTS the
        // restore chain applies it; `loadDocument` skips its show-the-top
        // reset for the same reason. A pending reveal (a link click's
        // target line) runs after this and still wins, cancelling the
        // chain.
        const memory = path !== null ? this.editor.caretFor(path) : undefined;
        const anchor = memory?.head ?? 0;
        this.surface().loadDocument(next, anchor, memory !== undefined);
        if (memory !== undefined) {
          this.scheduleScrollRestore(memory);
        }
      }
    }
    this.loadedPath = path;

    if (!samePath) {
      // Entering a tab: replay its remembered fold state (collapsed by default).
      this.surface().setFrontmatterExpanded(
        path !== null && this.frontmatterFoldByPath.get(path) === true,
      );
      // Land the caret IN the document: switching to a tab is an intent
      // to work there, so typing must work without a click into the
      // editor first. Only on a real switch -- a pane's first load (app
      // start, session restore, a freshly split pane) keeps the old
      // no-focus behavior.
      if (leavingPath !== null && path !== null) {
        this.surface().focus();
      }
    }
  }
}
