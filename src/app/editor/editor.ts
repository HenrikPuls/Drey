import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import MarkdownIt from 'markdown-it';
import { EditorService, stripFrontmatter } from '../services/editor.service';
import { blockIndexForNode, domPointToTextOffset, textOffsetToDomPoint } from './preview-caret';
import {
  alignRenderedToSource,
  blockClass,
  blockIndexForSourceOffset,
  renderWithSourceMap,
  sourceToRenderedOffset,
} from './source-map';

/**
 * CodeMirror 6 lives only in this component (CLAUDE.md, "Relevant
 * Components": EditorComponent = "CodeMirror 6 wrapper, source/rendered
 * toggle"). All document state is read from / pushed to `EditorService`
 * signals; this class owns nothing but the CM instance and the DOM.
 *
 * CodeMirror 6 was chosen by the spec specifically for its extension model
 * (spellcheck, syntax highlighting later plug in as extensions, no custom
 * plugin loader) -- so the editor is built as a single `EditorView` whose
 * `extensions` array is the extension point, not wrapped in indirection.
 *
 * "Rendered" view: no live preview (roadmap Phase 1 is explicit about the
 * tab-switch model). markdown-it renders the current buffer to HTML; the
 * string is bound through `[innerHTML]`, which runs Angular's built-in
 * HTML sanitizer -- and markdown-it is configured with `html: false`, so
 * raw HTML in a note is escaped rather than executed.
 *
 * Two ways back into source (CLAUDE.md, "click-to-edit"):
 *  - default: a click on the rendered output drops to source;
 *  - auto-switch mode (ADR-0004): the click only *places a caret* in the
 *    preview; the first character typed is what switches to source, landing
 *    the CM cursor at the matching offset; a save switches back to rendered
 *    at the CM cursor. `source-map.ts` / `preview-caret.ts` do the offset
 *    translation.
 *
 * Multi-tab (ADR-0003): there is still exactly one `EditorView`. Switching
 * tabs swaps its document to the newly active buffer via `loadActiveDoc()`.
 * Trade-off: CodeMirror's per-document undo history does not survive a tab
 * switch. Acceptable for the visual-shell milestone; keeping N mounted
 * views is the heavier alternative if that bites.
 */
@Component({
  selector: 'app-editor',
  templateUrl: './editor.html',
  styleUrl: './editor.css',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class Editor implements AfterViewInit, OnDestroy {
  protected readonly editor = inject(EditorService);

  private readonly cmHost = viewChild.required<ElementRef<HTMLDivElement>>('cmHost');
  private readonly previewDoc = viewChild<ElementRef<HTMLDivElement>>('previewDoc');
  private readonly md = new MarkdownIt({ html: false, linkify: true });
  private view?: EditorView;

  /** Last `newEntryRequest` counter value this component has acted on. */
  private handledEntryRequest = 0;
  /** Guards `placePreviewCaret` so it runs once per entry into rendered mode. */
  private caretPlacedForRender = false;

  /**
   * `bufferContent` split into the part `stripFrontmatter` removes and the
   * rest. `shift` converts a source offset in the stripped text (what the
   * source map works in) to an offset in the full buffer (what CodeMirror
   * and `caretOffset` use). `stripFrontmatter` only ever removes a prefix,
   * so the shift is a single number.
   */
  private readonly stripped = computed(() => {
    const buffer = this.editor.bufferContent();
    const text = stripFrontmatter(buffer);
    return { text, shift: buffer.length - text.length };
  });

  private readonly rendered = computed(() => renderWithSourceMap(this.md, this.stripped().text));
  protected readonly renderedHtml = computed(() => this.rendered().html);

  protected readonly wordCount = computed(() => {
    const words = this.editor.bufferContent().trim().split(/\s+/).filter(Boolean);
    return words.length;
  });

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

    // Quick-capture hotkey: start a new `## HH:mm` entry at the end of the
    // buffer. Handles the case where the note is already open; the
    // just-opened case is picked up in ngAfterViewInit (the view may not
    // exist yet when the request lands).
    effect(() => {
      const request = this.editor.newEntryRequest();
      if (this.view) {
        this.applyNewEntryRequest(request);
      }
    });

    // Auto-switch: on each entry into the rendered view, drop a DOM caret
    // at the position CodeMirror last had. Reads viewMode / activePath /
    // caretOffset so a save (which changes savedContent -> re-render) and a
    // tab switch both re-trigger it; a flag keeps it to one placement per
    // entry so it doesn't fight the user's own clicks.
    effect(() => {
      const mode = this.editor.viewMode();
      const auto = this.editor.autoSwitch();
      this.editor.activePath();
      const offset = this.editor.caretOffset();
      if (mode !== 'rendered' || !auto) {
        this.caretPlacedForRender = false;
        return;
      }
      if (this.caretPlacedForRender) {
        return;
      }
      this.caretPlacedForRender = true;
      // The rendered `@if` block and its `[innerHTML]` only exist after the
      // next change-detection pass -- defer past it before touching the DOM.
      this.deferToDom(() => this.placePreviewCaret(offset));
    });
  }

  ngAfterViewInit(): void {
    this.view = new EditorView({
      parent: this.cmHost().nativeElement,
      state: EditorState.create({
        doc: this.editor.bufferContent(),
        extensions: [
          basicSetup,
          markdown(),
          oneDark,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.editor.updateBuffer(update.state.doc.toString());
            }
            // Keep the shared caret in step with CodeMirror so a later
            // switch to the rendered view lands the preview caret here.
            if (update.docChanged || update.selectionSet) {
              this.editor.setCaretOffset(update.state.selection.main.head);
            }
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: "'Cascadia Code', 'Consolas', monospace",
            },
          }),
        ],
      }),
    });
    this.loadActiveDoc();
    // A hotkey request may have arrived while this component was still
    // mounting (hotkey on a not-yet-open file) -- the effect ran with no
    // view. Apply whatever is pending now.
    this.applyNewEntryRequest(this.editor.newEntryRequest());
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  protected async onKeydown(event: KeyboardEvent): Promise<void> {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const fromSource = this.editor.viewMode() === 'source';
      await this.editor.save();
      // Auto-switch: a save from source returns to the rendered view; the
      // caret effect then puts the preview caret where CM's cursor was.
      if (fromSource && this.editor.autoSwitch()) {
        this.editor.setViewMode('rendered');
      }
    }
  }

  /** Auto-switch: a click only positions the caret; it never switches to source. */
  protected onPreviewClick(): void {
    if (this.editor.autoSwitch()) {
      this.syncCaretFromDom();
    }
  }

  /** Auto-switch: a navigation keypress in the preview only re-reads the caret. */
  protected onPreviewKeyup(): void {
    if (this.editor.autoSwitch()) {
      this.syncCaretFromDom();
    }
  }

  /**
   * Auto-switch: the preview is `contenteditable` purely to get a native
   * caret and arrow-key navigation -- every actual edit is cancelled here
   * and replayed into CodeMirror instead, after switching to source at the
   * caret's source offset. Losing the first keystroke would be annoying, so
   * the intent (`insertText`, Enter, Backspace, Delete, paste) is applied.
   */
  protected onPreviewBeforeInput(event: InputEvent): void {
    if (!this.editor.autoSwitch()) {
      return;
    }
    event.preventDefault();
    this.syncCaretFromDom();

    let text: string | null = null;
    let deleteBefore = false;
    let deleteAfter = false;
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        text = event.data ?? '';
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        text = '\n';
        break;
      case 'insertFromPaste':
      case 'insertFromDrop':
        text = event.dataTransfer?.getData('text/plain') ?? '';
        break;
      case 'deleteContentBackward':
      case 'deleteWordBackward':
        deleteBefore = true;
        break;
      case 'deleteContentForward':
      case 'deleteWordForward':
        deleteAfter = true;
        break;
    }
    this.enterSourceForEdit({ text, deleteBefore, deleteAfter });
  }

  /**
   * Switches to the source view with the CM cursor at the shared caret
   * offset, then applies the pending edit so the keystroke that triggered
   * the switch is not lost.
   */
  private enterSourceForEdit(intent: {
    text: string | null;
    deleteBefore: boolean;
    deleteAfter: boolean;
  }): void {
    const view = this.view;
    this.editor.setViewMode('source');
    if (!view) {
      return;
    }
    const at = Math.min(Math.max(this.editor.caretOffset(), 0), view.state.doc.length);

    let spec: TransactionSpec = {
      selection: { anchor: at },
      scrollIntoView: true,
    };
    if (intent.text !== null) {
      spec = {
        changes: { from: at, insert: intent.text },
        selection: { anchor: at + intent.text.length },
        scrollIntoView: true,
      };
    } else if (intent.deleteBefore && at > 0) {
      spec = {
        changes: { from: at - 1, to: at },
        selection: { anchor: at - 1 },
        scrollIntoView: true,
      };
    } else if (intent.deleteAfter && at < view.state.doc.length) {
      spec = {
        changes: { from: at, to: at + 1 },
        selection: { anchor: at },
        scrollIntoView: true,
      };
    }
    view.dispatch(spec);
    // The CM state now has the right selection, but the editor is still
    // `display:none` until change detection swaps the views -- focusing and
    // scrolling a hidden editor is a no-op. Re-assert both once it's shown.
    const head = view.state.selection.main.head;
    this.deferToDom(() => {
      view.focus();
      view.dispatch({ selection: { anchor: head }, scrollIntoView: true });
    });
  }

  /**
   * Runs `fn` after the change-detection pass that the current signal
   * writes triggered, so the `@if`-swapped views are in the DOM. A
   * macrotask clears Angular's microtask-scheduled render.
   */
  private deferToDom(fn: () => void): void {
    setTimeout(fn, 0);
  }

  /**
   * Reads the browser's caret in the rendered view, translates it to a
   * buffer offset via the source map, and stores it as the shared caret.
   */
  private syncCaretFromDom(): void {
    const root = this.previewDoc()?.nativeElement;
    const selection = root?.ownerDocument.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return;
    }
    const { anchorNode, anchorOffset } = selection;
    if (!anchorNode || !root.contains(anchorNode)) {
      return;
    }

    // A click in block padding / past the end of a line / an empty block
    // gives an *element* anchor whose offset indexes child nodes -- walk
    // into the addressed child so it still resolves to a `cm-src` block.
    let node: Node = anchorNode;
    let offset = anchorOffset;
    if (node.nodeType === Node.ELEMENT_NODE && blockIndexForNode(node, root) === null) {
      const kids = node.childNodes;
      const child = kids[offset] ?? kids[offset - 1];
      if (child) {
        node = child;
        offset = child.nodeType === Node.TEXT_NODE ? (child as Text).data.length : 0;
      }
    }

    const blockIndex = blockIndexForNode(node, root);
    const { spans } = this.rendered();
    if (blockIndex === null || !spans[blockIndex]) {
      return;
    }
    const blockEl = root.querySelector<HTMLElement>(`.${blockClass(blockIndex)}`);
    if (!blockEl) {
      return;
    }

    const span = spans[blockIndex];
    const slice = this.stripped().text.slice(span.start, span.end);
    const renderedOffset = domPointToTextOffset(blockEl, node, offset);
    const r2s = alignRenderedToSource(slice, blockEl.textContent ?? '');
    const localSource = r2s[Math.min(renderedOffset, r2s.length - 1)] ?? 0;
    this.editor.setCaretOffset(this.stripped().shift + span.start + localSource);
  }

  /** Places the browser caret in the rendered view at buffer offset `bufferOffset`. */
  private placePreviewCaret(bufferOffset: number): void {
    const root = this.previewDoc()?.nativeElement;
    if (!root) {
      return;
    }
    const { text, shift } = this.stripped();
    const { spans } = this.rendered();
    const strippedOffset = Math.max(0, bufferOffset - shift);
    const blockIndex = blockIndexForSourceOffset(spans, strippedOffset);
    if (blockIndex === null) {
      return;
    }
    const blockEl = root.querySelector<HTMLElement>(`.${blockClass(blockIndex)}`);
    if (!blockEl) {
      return;
    }

    const span = spans[blockIndex];
    const slice = text.slice(span.start, span.end);
    const r2s = alignRenderedToSource(slice, blockEl.textContent ?? '');
    const renderedOffset = sourceToRenderedOffset(r2s, Math.max(0, strippedOffset - span.start));
    const point = textOffsetToDomPoint(blockEl, renderedOffset);

    try {
      // Focus first, then set the range: Chromium keeps a programmatic
      // selection only if the contenteditable host already has focus.
      root.focus({ preventScroll: true });
      const range = root.ownerDocument.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      const selection = root.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      blockEl.scrollIntoView({ block: 'nearest' });
    } catch {
      // Some environments refuse a selection in a non-editable subtree;
      // the caret just won't show, which is a cosmetic loss only.
    }
  }

  /**
   * Starts a new daily entry at the end of the document, unless `request`
   * has already been handled. Computes the edit from the live CM state via
   * `EditorService.newDailyEntryEdit` and dispatches it; when the doc
   * already ends with an empty `## HH:mm` heading it just moves the cursor
   * there. Either way the editor scrolls to and focuses the end.
   */
  private applyNewEntryRequest(request: number): void {
    const view = this.view;
    if (!view || request === 0 || request === this.handledEntryRequest) {
      return;
    }
    this.handledEntryRequest = request;

    const edit = this.editor.newDailyEntryEdit(view.state.doc.toString());
    if (edit) {
      view.dispatch({
        changes: { from: edit.at, insert: edit.insert },
        selection: { anchor: edit.at + edit.insert.length },
        scrollIntoView: true,
      });
    } else {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
    }
    view.focus();
  }

  /**
   * Pushes the active tab's buffer into CodeMirror. Called on tab switch
   * and after a save. Guarded so that the echo from the update listener
   * (buffer changes -> effect re-runs) is a no-op, and so switching to a
   * tab whose text CM already shows costs nothing.
   */
  private loadActiveDoc(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const next = this.editor.bufferContent();
    if (next === view.state.doc.toString()) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: 0 },
    });
  }
}
