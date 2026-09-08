import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { completionStatus } from '@codemirror/autocomplete';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { EditorService, EditorViewMode } from '../../services/editor.service';
import { EditTargetService } from '../../services/edit-target.service';
import { EditorZoomService } from '../../services/editor-zoom.service';
import { ImageLightboxService } from '../../image-viewer';
import { TagService } from '../../services/tag.service';
import { VaultService } from '../../services/vault.service';
import { dreyEditorLook } from '../editor-theme';
import { imagePaste } from '../image-paste';
import { toggleTaskDone } from '../markdown-commands';
import {
  frontmatterExpandedOf,
  frontmatterFold,
  setFrontmatterExpanded,
} from '../frontmatter-fold';
import { livePreview } from '../live-preview';
import { inlineSpellcheck, requestSpellcheck, SpellcheckSource } from '../spellcheck/spellcheck';
import { makeTagCompletionSource } from '../tag-complete';
import { tagPills } from '../tag-pill';
import { resolveVaultImageUrl } from '../vault-image';

/**
 * The one reusable CodeMirror Markdown surface: the full-page editor and the
 * entry drawer's body field are the *same* component, so Live Preview
 * behaves identically in both (ADR-0009). Owns the `EditorView`, the
 * Markdown language setup (nested fenced-code parsers via
 * `@codemirror/language-data`, HTML tag autocompletion off -- a note editor
 * doesn't want a popup on `<`), `#tag` autocomplete, and the mode
 * compartment that swaps the Live Preview extensions in and out.
 *
 * `compact` swaps the page padding for a slimmer theme. With
 * `submitOnEnter` (the default) Enter also emits `submitRequested` instead
 * of inserting a newline (Shift+Enter still breaks the line; an open
 * autocomplete popup keeps Enter) -- the drawer turns that off, because its
 * body is multi-line Markdown with its own submit button.
 *
 * Document state stays with the *owner*: the component emits `docChanged`
 * and exposes `view` / `setContent` -- it never talks to `EditorService`
 * buffers itself (images resolve against the active document's path, which
 * is where both use sites want them to land).
 */
@Component({
  selector: 'app-markdown-surface',
  template: '<div #host class="host"></div>',
  styles: ':host { display: block; min-height: 0; } .host { height: 100%; }',
})
export class MarkdownSurface implements AfterViewInit, OnDestroy {
  private readonly editor = inject(EditorService);
  private readonly editTarget = inject(EditTargetService);
  private readonly tags = inject(TagService);
  private readonly vault = inject(VaultService);
  private readonly zoom = inject(EditorZoomService);
  private readonly lightbox = inject(ImageLightboxService);
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly mode = input<EditorViewMode>('live');
  readonly compact = input(false);
  /**
   * Shows a line-number gutter (full-page editor only, toggled from the
   * meta bar / `Ctrl+G`). `basicSetup` already mounts the gutter DOM; this
   * just un-hides + restyles it to the v3 spec via a compartment.
   */
  readonly lineNumbers = input(false);
  /**
   * Folds the leading YAML frontmatter behind a pill (both modes). Only the
   * full-page editor turns this on; the entry drawer's body never has
   * frontmatter. Read once at construction -- it never toggles per surface.
   */
  readonly foldFrontmatter = input(false);
  readonly placeholder = input('');
  /**
   * Turns on image paste / drop: a pasted or dropped image is saved into
   * the vault's per-note `attachments/` folder and an `![](…)` link is
   * inserted at the caret (ADR-0024). Read once at construction. The
   * full-page editor and the "Add entry" drawer set it; the note
   * assistant composer (a prompt box, not a document) does not.
   */
  readonly imageCapture = input(false);
  /**
   * Makes the surface non-editable (the note assistant composer while no
   * note is open). Programmatic `setContent` still works -- this only
   * blocks user input, like a disabled field.
   */
  readonly readOnly = input(false);
  /**
   * Turns on the inline spellchecker (red wavy underline + click popup)
   * for this surface. `null` -- the default -- leaves the extension out
   * entirely, so the full-page editor pays nothing for it. Read once at
   * construction: the source object is stable, only its answers change.
   */
  readonly spellcheck = input<SpellcheckSource | null>(null);
  /**
   * Compact mode only: whether Enter submits (the old capture bar) or
   * inserts a newline. The entry drawer's body field is compact *and*
   * multi-line -- it is Markdown prose with its own submit button -- so it
   * turns this off.
   */
  readonly submitOnEnter = input(true);
  /**
   * When set, inline `#tag`s render as pills and a `Ctrl`/`Cmd`-click on
   * one calls this with the bare tag. Read once at construction. The full-
   * page editor wires it to the tag search; the entry drawer leaves it
   * unset (composing a note, not navigating it).
   */
  readonly onTagActivate = input<(tag: string) => void>();

  /** The document text after every edit. */
  readonly docChanged = output<string>();
  /** Compact mode only: Enter was pressed; payload is the current text. */
  readonly submitRequested = output<string>();
  /** Compact mode only: Ctrl/Cmd+Space was pressed (chat Input/Ask toggle, ADR-0011). */
  readonly modeToggleRequested = output<void>();

  private _view?: EditorView;
  private readonly modeCompartment = new Compartment();
  private readonly placeholderCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private readonly lineNumberCompartment = new Compartment();

  /**
   * Mirror of the fold extension's `StateField<boolean>` (see
   * `frontmatter-fold.ts`): CodeMirror owns the state, this signal only
   * reflects it so the owner can read it (e.g. to remember it per tab). Set
   * it through `setFrontmatterExpanded()`, not directly.
   */
  private readonly _frontmatterExpanded = signal(false);
  readonly frontmatterExpanded = this._frontmatterExpanded.asReadonly();

  /** The CodeMirror view; defined after `ngAfterViewInit`. */
  get view(): EditorView | undefined {
    return this._view;
  }

  constructor() {
    effect(() => {
      const mode = this.mode();
      this._view?.dispatch({
        effects: this.modeCompartment.reconfigure(this.modeExtensions(mode)),
      });
    });
    effect(() => {
      const text = this.placeholder();
      this._view?.dispatch({
        effects: this.placeholderCompartment.reconfigure(text ? cmPlaceholder(text) : []),
      });
    });
    effect(() => {
      const ro = this.readOnly();
      this._view?.dispatch({
        effects: this.readOnlyCompartment.reconfigure(ro ? readOnlyExtension : []),
      });
    });
    effect(() => {
      const on = this.lineNumbers();
      this._view?.dispatch({
        effects: this.lineNumberCompartment.reconfigure(on ? gutterTheme : []),
      });
    });
    // The editor content scale (Ctrl +/-/0) is a CSS custom property on the
    // host that CodeMirror's theme reads but never reacts to -- without a
    // nudge the selection/cursor geometry stays at the old font size until
    // the next edit or scroll. `requestMeasure` re-measures on the next
    // frame, after the browser has applied the new size.
    effect(() => {
      this.zoom.scale();
      this._view?.requestMeasure();
    });
  }

  ngAfterViewInit(): void {
    this._view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: '',
        extensions: [
          // Above basicSetup so Enter wins over insertNewline -- but an
          // active completion popup keeps its Enter (accept).
          this.compact() && this.submitOnEnter()
            ? Prec.highest(keymap.of(this.submitKeymap()))
            : [],
          basicSetup,
          // `Ctrl/Cmd+Enter` toggles the task checkbox on the selected
          // line(s) (also the Selection menu's "Toggle task done").
          keymap.of([{ key: 'Mod-Enter', run: (view) => toggleTaskDone(view) }]),
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
            completeHTMLTags: false,
          }),
          // `#tag` completion, keyed off the live TagService signal so a
          // vault change needs no editor rebuild.
          markdownLanguage.data.of({
            autocomplete: makeTagCompletionSource(() => this.tags.tags()),
          }),
          // `#tag` pills + Ctrl/Cmd-click -> search. Outside the mode
          // compartment: pills show in source mode too.
          this.onTagActivate() ? tagPills(this.onTagActivate()!) : [],
          // Track this surface as the Edit/Selection menu's target while it
          // holds focus (see `EditTargetService` -- "last focused", so a
          // menu-bar click doesn't drop it).
          EditorView.domEventHandlers({
            focus: () => {
              if (this._view) {
                this.editTarget.register(this._view);
              }
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.docChanged.emit(update.state.doc.toString());
            }
            const expanded = frontmatterExpandedOf(update.state);
            if (expanded !== this._frontmatterExpanded()) {
              this._frontmatterExpanded.set(expanded);
            }
          }),
          dreyEditorLook,
          // Compact surfaces (entry drawer, note assistant composer) are
          // narrow single-purpose fields -- long lines must wrap, not
          // scroll sideways. The full-page editor keeps its own behaviour.
          //
          // `Prec.high` is load-bearing: `compactTheme` restyles `.cm-content`
          // (drops the full-page 40px top padding), but at equal precedence
          // CodeMirror lets the style module declared *earlier* -- here
          // `dreyEditorLook` -- win the cascade, so the compact field would
          // otherwise open with its first line pushed 40px down.
          this.compact() ? [Prec.high(compactTheme), EditorView.lineWrapping] : [],
          this.spellcheck() ? inlineSpellcheck({ source: this.spellcheck()! }) : [],
          this.imageCapture()
            ? imagePaste({
                save: (bytes, ext) =>
                  this.vault.saveAsset(bytes, ext, this.editor.openPath() ?? ''),
                notePath: () => this.editor.openPath(),
                readTextFile: (path) => this.vault.readTextFile(path),
                onError: (message) => this.editor.error.set(message),
              })
            : [],
          // Outside the mode compartment on purpose: the frontmatter pill
          // shows in source mode too, and its fold state must survive a
          // Live Preview <-> source switch.
          this.foldFrontmatter() ? frontmatterFold() : [],
          this.placeholderCompartment.of(
            this.placeholder() ? cmPlaceholder(this.placeholder()) : [],
          ),
          this.readOnlyCompartment.of(this.readOnly() ? readOnlyExtension : []),
          this.lineNumberCompartment.of(this.lineNumbers() ? gutterTheme : []),
          this.modeCompartment.of(this.modeExtensions(this.mode())),
        ],
      }),
    });
    // Pick up any tags registered after TagService first constructed
    // (e.g. a vault selected later in the session).
    void this.tags.refresh();
  }

  ngOnDestroy(): void {
    if (this._view) {
      this.editTarget.unregister(this._view);
      this._view.destroy();
    }
  }

  /** Replaces the whole document (owner-driven loads, clearing the capture box). */
  setContent(text: string, anchor = 0): void {
    const view = this._view;
    if (!view) {
      return;
    }
    const resolvedAnchor = Math.min(anchor, text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: resolvedAnchor },
    });
    // A fresh open (anchor at the very top) must also *show* the top:
    // CodeMirror keeps the previous scroll offset across a full document
    // swap, so after creating an entry at the end and then loading another
    // doc the view would stay scrolled down. Safe to set synchronously --
    // this dispatch carries no `scrollIntoView`, so CodeMirror does not
    // re-scroll to the selection afterwards. A non-zero anchor (the
    // full-page editor's same-path reload) deliberately keeps position.
    if (resolvedAnchor === 0) {
      view.scrollDOM.scrollTop = 0;
    }
  }

  getContent(): string {
    return this._view?.state.doc.toString() ?? '';
  }

  focus(): void {
    this._view?.focus();
  }

  /**
   * Re-runs the spellcheck without a text change. The owner calls this when
   * its own precondition for checking has flipped (the entry drawer: a topic
   * or chip was added), since the extension cannot observe that itself.
   */
  recheckSpelling(): void {
    const view = this._view;
    if (view && this.spellcheck()) {
      requestSpellcheck(view);
    }
  }

  /**
   * Expand or fold the frontmatter (only meaningful with `foldFrontmatter`).
   * The owner calls this on tab switch to replay the tab's remembered state;
   * the pill and chevron flip it from inside CodeMirror.
   */
  setFrontmatterExpanded(expanded: boolean): void {
    const view = this._view;
    if (view && frontmatterExpandedOf(view.state) !== expanded) {
      view.dispatch({ effects: setFrontmatterExpanded.of(expanded) });
    }
  }

  private modeExtensions(mode: EditorViewMode): Extension {
    return mode === 'live'
      ? livePreview({
          resolveImage: (url) => resolveVaultImageUrl(this.editor.openPath(), url),
          onOpenImage: (src) => this.lightbox.open(src),
        })
      : [];
  }

  private submitKeymap() {
    return [
      {
        key: 'Enter',
        run: (view: EditorView): boolean => {
          if (completionStatus(view.state) === 'active') {
            return false;
          }
          this.submitRequested.emit(view.state.doc.toString());
          return true;
        },
      },
      { key: 'Shift-Enter', run: insertNewlineAndIndent },
      {
        // Wins over `@codemirror/autocomplete`'s Mod-Space (start completion)
        // in the compact bar only -- here it toggles chat Input/Ask.
        key: 'Mod-Space',
        run: (): boolean => {
          this.modeToggleRequested.emit();
          return true;
        },
      },
    ];
  }
}

/** Blocks user input while still allowing owner-driven `setContent`. */
const readOnlyExtension: Extension = [EditorView.editable.of(false), EditorState.readOnly.of(true)];

/**
 * Un-hides the gutter `basicSetup` already mounts (the base theme keeps
 * `.cm-gutters` `display:none`) and restyles the line numbers to the v3
 * spec: 46px column, Plex Mono 10.5, right-aligned, no fold arrows.
 * `Prec.high` so it beats the base `.cm-gutters` rule. No extra
 * `lineNumbers()` extension -- `basicSetup` already provides one.
 */
const gutterTheme: Extension = Prec.high(
  EditorView.theme({
    '.cm-gutters': {
      display: 'flex',
      backgroundColor: 'transparent',
      borderRight: 'none',
      color: 'var(--gutter)',
    },
    '.cm-foldGutter': { display: 'none' },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '46px',
      padding: '0 14px 0 6px',
      fontFamily: 'var(--font-mono)',
      fontSize: 'calc(10.5px * var(--drey-editor-scale, 1))',
      color: 'var(--gutter)',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  }),
);

/**
 * Compact field look: no page padding. Fills its container so the editable
 * area grows with whatever height the owner gives it (the entry drawer caps
 * it); long content scrolls inside `.cm-scroller`.
 */
const compactTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontSize: '14px',
    lineHeight: '1.5',
  },
  '.cm-content': {
    maxWidth: 'none',
    margin: '0',
    padding: '5px 0 2px',
  },
  '.cm-placeholder': {
    color: 'var(--text-6)',
  },
});
