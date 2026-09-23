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
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Extension, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { EditorService, EditorViewMode } from '../../services/editor.service';
import { EditTargetService } from '../../services/edit-target.service';
import { EditorZoomService } from '../../services/editor-zoom.service';
import { ImageLightboxService } from '../../image-viewer';
import { VaultService } from '../../vault';
import { ThemeService } from '../../services/theme.service';
import { ThemeCatalogEntry } from '../themes/theme-catalog';
import { dreyEditorLook, editorStructure, headingTypographyStyle } from '../editor-theme';
import { editorIndentation } from '../editor-indent';
import { imagePaste } from '../image-paste';
import {
  frontmatterExpandedOf,
  frontmatterFold,
  setFrontmatterExpanded,
} from '../frontmatter-fold';
import { livePreview } from '../live-preview';
import { inlineSpellcheck, requestSpellcheck, SpellcheckSource } from '../spellcheck/spellcheck';
import { linkActivation } from '../link-open';
import { WikilinkService, makeWikilinkCompletionSource, wikilinks } from '../wikilinks';
import { pasteUrlAsMarkdownLink } from '../paste-link';
import { assetUrlToVaultPath, resolveVaultImageCandidates } from '../vault-image';
import { makeTagCompletionSource, tagPills, tagStyleRefresh } from '../tags';
import { makeWordCompletionSource } from '../word-completion';
import { TagVocabularyService } from '../../tags/tag-vocabulary.service';
import { KeybindingService } from '../../keybindings';
import { EditorExtensionRegistry, DropDecoderRegistry } from '../../plugin-host';

/** How close to the bottom (px) counts as "pinned" for `setContent`'s
 * stick-to-bottom behaviour on external in-place reloads. Same idea as the
 * assistant transcript's proximity check. */
const STICK_TO_BOTTOM_PX = 32;

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
  private readonly vault = inject(VaultService);
  private readonly themes = inject(ThemeService);
  private readonly zoom = inject(EditorZoomService);
  private readonly lightbox = inject(ImageLightboxService);
  private readonly wikiLinks = inject(WikilinkService);
  private readonly tagVocab = inject(TagVocabularyService);
  private readonly keys = inject(KeybindingService);
  private readonly pluginExtensions = inject(EditorExtensionRegistry);
  private readonly dropDecoders = inject(DropDecoderRegistry);
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
  /**
   * The active document's filename / path. Its extension picks the
   * CodeMirror language: `.md` / `.markdown` / `.mdx` (or `null` / no
   * extension) -> the full Markdown bundle (grammar + `#tag` autocomplete +
   * tag pills + link activation + inline spellcheck + frontmatter fold);
   * anything else -> that language's grammar alone, so a `.cpp` / `.json` /
   * `.ts` file gets real syntax highlighting and none of the Markdown-only
   * chrome (`#include` must not become a `#tag` pill). Swapped live through
   * a compartment -- one surface serves every tab. Only the full-page
   * editor sets it; the compact composers leave it `null` (always Markdown).
   */
  readonly languageFilename = input<string | null>(null);
  /**
   * The shown document's vault id (ADR-0051), for vault-scoped features
   * (wikilink resolve/completion). `null` = the active vault.
   */
  readonly docVaultId = input<string | null>(null);
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
   * When set, a `Ctrl`/`Cmd`-click on a Markdown link calls this with the
   * raw target. Read once at construction. The full-page editor wires it to
   * open web links externally / vault links in a tab; the entry drawer
   * leaves it unset.
   */
  readonly onLinkActivate = input<(href: string) => void>();
  /**
   * When set, a `Ctrl`/`Cmd`-click on a `[[wikilink]]` calls this with the
   * target and the `#heading` anchor (or null). Read once at construction.
   * The full-page editor resolves + opens (creating a missing note); the
   * entry drawer only follows existing notes. Unset surfaces still render
   * and complete the links -- they just don't activate on click.
   */
  readonly onWikilinkActivate = input<(target: string, anchor: string | null) => void>();

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
  /**
   * The live-edit lock (ADR-0049): holds ONLY `EditorView.editable` —
   * unlike `readOnlyCompartment` it deliberately leaves
   * `EditorState.readOnly` out, so owner-driven `setContent` (the model's
   * buffer pushes) keeps flowing AND stays in the undo history while user
   * typing is blocked.
   */
  private readonly editLockCompartment = new Compartment();
  private readonly lineNumberCompartment = new Compartment();
  /** Swaps the whole CM6 theme (chrome + syntax) when Settings -> Appearance changes. */
  private readonly themeCompartment = new Compartment();
  /** Holds the plugins' contributed extensions (ADR-0044 stage 2); reconfigured on registry change. */
  private readonly pluginCompartment = new Compartment();
  /** Guards against an out-of-order theme `load()` resolving after a newer pick. */
  private themeToken = 0;
  /** Holds the language grammar (+ Markdown chrome) for the active tab; see `languageFilename`. */
  private readonly languageCompartment = new Compartment();
  /** Guards against an out-of-order language `load()` resolving after a newer tab. */
  private langToken = 0;
  /** The language currently in the compartment (`'markdown'` | `'plain'` | `'lang:<name>'`). */
  private currentLangKey = 'markdown';
  /** Last frontmatter fold state the owner asked for; re-asserted after a code -> Markdown swap. */
  private desiredFrontmatterExpanded = false;

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
    effect(() => {
      this.applyTheme(this.themes.theme());
    });
    effect(() => {
      void this.applyLanguage(this.languageFilename());
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
    // Plugin-contributed extensions (ADR-0044): reconfigure whenever the
    // registry's set changes. A factory is evaluated per reconfigure with
    // this surface's context.
    effect(() => {
      void this.pluginExtensions.revision();
      this._view?.dispatch({
        effects: this.pluginCompartment.reconfigure(this.collectPluginExtensions()),
      });
    });
    // Tag prefix colors changed (Settings → Tags): nudge the pill plugin to
    // re-resolve its colors now, not at the next scroll/edit.
    effect(() => {
      this.tagVocab.stylesRevision();
      this._view?.dispatch({ effects: tagStyleRefresh.of(null) });
    });
  }

  /**
   * Evaluates the registered plugin extension factories for this surface.
   * `compact` surfaces are composer slots; the full-page editor is the
   * document slot. `path`/`filename` read the ACTIVE file at call time
   * (both from `languageFilename`, which carries the tab's path-like name).
   */
  private collectPluginExtensions(): Extension {
    const slot = this.compact() ? 'composer' : 'document';
    const filename = (): string | null => this.languageFilename();
    return this.pluginExtensions.extensionsFor(slot, {
      slot,
      path: filename,
      filename,
    }) as Extension[];
  }

  /**
   * Loads the selected theme's CM6 extension (Drey resolves synchronously;
   * a published theme is a lazy `import()`) and swaps it into the
   * compartment. The token check drops a slow load whose theme is no longer
   * the current pick.
   */
  private applyTheme(entry: ThemeCatalogEntry): void {
    const token = ++this.themeToken;
    void entry.load().then((ext) => {
      if (token === this.themeToken) {
        this._view?.dispatch({ effects: this.themeCompartment.reconfigure(ext) });
      }
    });
  }

  /**
   * The Markdown language plus every Markdown-only surface feature: `#tag`
   * autocomplete, the `#tag` pills / link activation (both work in source
   * mode too), inline spellcheck and the frontmatter fold. This is what the
   * language compartment holds for a `.md` tab and for every compact
   * composer; a code tab gets `LanguageDescription.load()`'s grammar
   * instead and none of this.
   */
  private markdownBundle(): Extension {
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        completeHTMLTags: false,
        // `markdownLanguage` bakes in `@lezer/markdown`'s `Emoji` inline
        // parser, whose `:name:` rule is `/^[a-zA-Z_0-9]+:/` -- digits alone
        // count, so a bare timestamp like `2026-09-09T00:03:48` has its
        // `:03:` slice parsed as an `Emoji` node and coloured as such. We
        // never render `:shortcode:` emoji, so drop the parser: the text
        // stays plain.
        extensions: [{ remove: ['Emoji'] }],
      }),
      // `#tag` completion + pills are BASE editor features (milestone 33 —
      // moved out of the Tags plugin, which stays the data owner): colored
      // pills, Ctrl/Cmd-click -> the Search panel's `search.open` with
      // `{ tag }`, completion from the tag vocabulary service.
      tagPills({
        colorFor: (tag) => this.tagVocab.styleFor(tag).color,
        onActivate: (tag) => this.keys.run('search.open', { tag }),
      }),
      markdownLanguage.data.of({
        autocomplete: makeTagCompletionSource({
          getTags: () => this.tagVocab.entries(),
          colorFor: (tag) => this.tagVocab.styleFor(tag).color,
        }),
      }),
      this.onLinkActivate() ? linkActivation(this.onLinkActivate()!) : [],
      // `[[wikilinks]]` (req-20): styled + clickable in both modes (this is
      // the language compartment; only the bracket concealing is
      // Live-Preview-only, via the conceal layer). `languageFilename()`
      // carries the tab's path for sibling-first resolution and is `null`
      // in the composers; `docVaultId()` scopes resolution to the shown
      // doc's vault (ADR-0051).
      wikilinks({
        resolve: (target) =>
          this.wikiLinks.resolve(target, this.docVaultId(), this.languageFilename()) !== null,
        onActivate: this.onWikilinkActivate(),
      }),
      markdownLanguage.data.of({
        autocomplete: makeWikilinkCompletionSource(() =>
          this.wikiLinks.noteNames(this.docVaultId()),
        ),
      }),
      // Word completion (milestone 40): repeat the document's own words in
      // prose/heading/table contexts. Not on the Enter-submits composers --
      // there the popup would swallow Enter (accept) that must submit.
      !(this.compact() && this.submitOnEnter())
        ? markdownLanguage.data.of({
            autocomplete: makeWordCompletionSource(),
          })
        : [],
      // Paste a bare URL onto an empty caret -> `[url](url)` (lang-markdown's
      // own pasteURLAsLink only handles the wrap-a-selection case).
      pasteUrlAsMarkdownLink(),
      this.spellcheck() ? inlineSpellcheck({ source: this.spellcheck()! }) : [],
      this.foldFrontmatter() ? frontmatterFold() : [],
    ];
  }

  /**
   * Swaps the language compartment to match `name`'s extension. `.md` /
   * `.markdown` / `.mdx` / `null` -> `markdownBundle()`; a filename CM knows
   * -> its grammar (lazy `import()`, token-guarded like `applyTheme`);
   * anything else -> plain text. `currentLangKey` skips a no-op reconfigure,
   * so switching between two Markdown tabs never tears down the frontmatter
   * fold's `StateField`.
   */
  private async applyLanguage(name: string | null): Promise<void> {
    const view = this._view;
    if (!view) {
      return;
    }
    const isMarkdown = !name || /\.(md|markdown|mdx)$/i.test(name);
    if (isMarkdown) {
      if (this.currentLangKey === 'markdown') {
        return;
      }
      this.currentLangKey = 'markdown';
      this.langToken++;
      view.dispatch({ effects: this.languageCompartment.reconfigure(this.markdownBundle()) });
      // The fold `StateField` is brand new (`create: () => false`); if the
      // owner already replayed an expanded tab before this ran, re-apply it.
      if (this.desiredFrontmatterExpanded && this.foldFrontmatter()) {
        view.dispatch({ effects: setFrontmatterExpanded.of(true) });
      }
      return;
    }

    const desc = LanguageDescription.matchFilename(languages, name);
    const key = desc ? `lang:${desc.name}` : 'plain';
    if (this.currentLangKey === key) {
      return;
    }
    this.currentLangKey = key;
    const token = ++this.langToken;
    if (!desc) {
      view.dispatch({ effects: this.languageCompartment.reconfigure([]) });
      return;
    }
    try {
      const support = await desc.load();
      if (token === this.langToken) {
        this._view?.dispatch({ effects: this.languageCompartment.reconfigure(support) });
      }
    } catch {
      if (token === this.langToken) {
        this._view?.dispatch({ effects: this.languageCompartment.reconfigure([]) });
      }
    }
  }

  ngAfterViewInit(): void {
    this._view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: '',
        extensions: this.buildExtensions(null),
      }),
    });
    // The compartment is seeded with the Markdown bundle; if this surface
    // opened straight onto a code file, swap the grammar now rather than
    // waiting for the first `languageFilename` change.
    void this.applyLanguage(this.languageFilename());
  }

  /**
   * The surface's full extension list. `previous === null` seeds every
   * compartment from the current inputs (initial construction); otherwise
   * each compartment carries over exactly what the previous state held
   * (`Compartment.get`), so a fresh state built by `loadDocument` re-styles
   * the incoming document identically before any effect re-runs. The
   * language compartment rides the seed too: `currentLangKey` describes
   * what the compartment holds, and `applyLanguage()` reconfigures when the
   * next document's grammar differs.
   */
  private buildExtensions(previous: EditorState | null): Extension[] {
    const seed = (compartment: Compartment, initial: Extension): Extension =>
      previous === null ? initial : (compartment.get(previous) ?? initial);
    return [
      // Above basicSetup so Enter wins over insertNewline -- but an
      // active completion popup keeps its Enter (accept).
      this.compact() && this.submitOnEnter() ? Prec.highest(keymap.of(this.submitKeymap())) : [],
      // Tab = insert a tab / indent the selection (bug-9); above
      // basicSetup, which ships no Tab binding at all -- unbound, the
      // key fell through to the browser's focus navigation.
      editorIndentation,
      basicSetup,
      // The language grammar + (for Markdown) the `#tag` autocomplete /
      // pills / link activation / spellcheck / frontmatter fold. Seeded
      // with the Markdown bundle; `applyLanguage()` swaps in a code
      // grammar (and drops the Markdown chrome) for a non-`.md` tab.
      this.languageCompartment.of(seed(this.languageCompartment, this.markdownBundle())),
      // Plugin-contributed extensions (ADR-0044 stage 2), in their own
      // compartment so a (de)registration reconfigures without touching
      // the language state.
      this.pluginCompartment.of(seed(this.pluginCompartment, this.collectPluginExtensions())),
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
          // A checkbox CLICK is an explicit "done" gesture — same
          // semantics as the Tasks panel's row toggle (which always
          // saved): persist immediately, or the vault-scope task list
          // (a disk index) never adopts the change until an unrelated
          // save. `input.toggleTask` without the suffix is the
          // Mod+Enter editing command and stays buffer-only.
          if (
            update.transactions.some(
              (tr) => tr.annotation(Transaction.userEvent) === 'input.toggleTask.click',
            )
          ) {
            const path = this.languageFilename();
            if (path !== null && path !== '') {
              // Deferred: an ipcRenderer.invoke kicked off from inside
              // the CM update stack never sees its promise settle --
              // the save continues outside the transaction.
              setTimeout(() => void this.editor.save({ path }), 0);
            }
          }
        }
        const expanded = frontmatterExpandedOf(update.state);
        if (expanded !== this._frontmatterExpanded()) {
          this._frontmatterExpanded.set(expanded);
        }
      }),
      // The active CM6 theme. Seeded with Drey (local, synchronous) and
      // swapped by `applyTheme()` -- a published theme is a lazy import,
      // so it arrives a microtask/frame later. In a compartment so
      // Settings -> Appearance can swap it live without a view rebuild.
      this.themeCompartment.of(seed(this.themeCompartment, dreyEditorLook)),
      // Layout skeleton (height, scroll, content padding, hidden
      // gutter) -- kept out of the swappable theme so a published theme
      // can't drop it. After the compartment so it wins on equal
      // specificity; `gutterTheme` / `compactTheme` (Prec.high) still
      // override where they need to.
      editorStructure,
      // Per-level heading typography, also outside the theme
      // compartment (a published theme flattens h1-h6 to one style or
      // drops them entirely -- the beta feedback). `Prec.high` is
      // load-bearing, same quirk as `compactTheme` below: it must beat
      // the theme compartment's own heading rules at equal
      // specificity. Typography only -- the theme keeps supplying the
      // heading colours.
      Prec.high(syntaxHighlighting(headingTypographyStyle)),
      // Long lines wrap at the editor's width instead of scrolling the
      // content sideways -- the full-page editor now fills the whole
      // area (no centred column), so a horizontal scrollbar there would
      // just be noise.
      EditorView.lineWrapping,
      // Compact surfaces (entry drawer, note assistant composer) also
      // get a slimmer theme.
      //
      // `Prec.high` is load-bearing: `compactTheme` restyles `.cm-content`
      // (drops the full-page 40px top padding), but at equal precedence
      // CodeMirror lets the style module declared *earlier* -- the theme
      // compartment above -- win the cascade, so the compact field would
      // otherwise open with its first line pushed 40px down.
      this.compact() ? Prec.high(compactTheme) : [],
      this.imageCapture()
        ? imagePaste({
            save: (bytes, ext) =>
              this.vault.saveAsset(
                bytes,
                ext,
                this.editor.openPath() ?? '',
                this.editor.openVaultId() ?? this.vault.activeVaultId(),
              ),
            // PDFs keep their file name in attachments/ (ADR-0052).
            saveNamed: (bytes, fileName) =>
              this.vault.saveNamedAsset(
                bytes,
                fileName,
                this.editor.openPath() ?? '',
                this.editor.openVaultId() ?? this.vault.activeVaultId(),
              ),
            notePath: () => this.editor.openPath(),
            readTextFile: (path, vaultId) =>
              this.vault.readTextFile(path, vaultId ?? this.editor.openVaultId() ?? undefined),
            saveFromUrl: (url) =>
              this.vault.saveAssetFromUrl(
                url,
                this.editor.openPath() ?? '',
                this.editor.openVaultId() ?? this.vault.activeVaultId(),
              ),
            // Plugin drop decoders claim a drop before the base cascade
            // (the .ics/.msg meeting decoder is the Meeting plugin's).
            dropClaimed: (data) => this.dropDecoders.claims(data),
            decodeDropped: async (data) => (await this.dropDecoders.decode(data)) ?? '',
            onError: (message) => this.editor.error.set(message),
          })
        : [],
      this.placeholderCompartment.of(
        seed(
          this.placeholderCompartment,
          this.placeholder() ? cmPlaceholder(this.placeholder()) : [],
        ),
      ),
      this.readOnlyCompartment.of(
        seed(this.readOnlyCompartment, this.readOnly() ? readOnlyExtension : []),
      ),
      this.editLockCompartment.of(seed(this.editLockCompartment, [])),
      this.lineNumberCompartment.of(
        seed(this.lineNumberCompartment, this.lineNumbers() ? gutterTheme : []),
      ),
      this.modeCompartment.of(seed(this.modeCompartment, this.modeExtensions(this.mode()))),
    ];
  }

  ngOnDestroy(): void {
    if (this._view) {
      this.editTarget.unregister(this._view);
      this._view.destroy();
    }
  }

  /**
   * Replaces the whole document with a FRESH editor state: the text becomes
   * the state's own doc instead of being dispatched in, so the load is not
   * an undo event and the tab starts with an empty undo stack ("undo
   * history does not survive a tab switch", ADR-0037). A dispatched load
   * sits at the bottom of the history instead -- undoing past the first
   * real edit rolled the LOAD back and wiped the document (and an undo
   * across a tab switch could resurrect the *previous* tab's content).
   *
   * This is the path for a FIRST load and every TAB SWITCH. An in-place
   * reload of the same document (save pipeline, watcher, live-edit pushes)
   * must stay undoable -- use `setContent` there.
   */
  loadDocument(text: string, anchor = 0): void {
    const view = this._view;
    if (!view) {
      return;
    }
    const resolvedAnchor = Math.min(anchor, text.length);
    view.setState(
      EditorState.create({
        doc: text,
        extensions: this.buildExtensions(view.state),
        selection: { anchor: resolvedAnchor },
      }),
    );
    // Same reasoning as in `setContent`: a fresh open must *show* the top.
    if (resolvedAnchor === 0) {
      view.scrollDOM.scrollTop = 0;
    }
  }

  /**
   * Replaces the whole document as a single UNDOABLE edit, keeping the
   * caret at `anchor` (owner-driven in-place reloads: the save pipeline's
   * frontmatter rewrite, a watcher reload, each live-edit buffer push --
   * ADR-0049 keeps every push one undo step). A fresh open / tab switch
   * must use `loadDocument` instead.
   */
  setContent(text: string, anchor = 0): void {
    const view = this._view;
    if (!view) {
      return;
    }
    const resolvedAnchor = Math.min(anchor, text.length);
    // Stick-to-bottom for external in-place reloads (the streamed search
    // summary, a live-edit push): follow the growing tail while the user is
    // pinned at the bottom, leave their position alone otherwise. Measured
    // BEFORE the swap -- CodeMirror keeps the previous scroll offset across
    // a full document replace, so a pinned view would drift off the bottom
    // as the content grows. This dispatch carries no `scrollIntoView`, so
    // CodeMirror does not re-scroll to the selection afterwards.
    const scrollDOM = view.scrollDOM;
    const pinned =
      scrollDOM.clientHeight > 0 &&
      scrollDOM.scrollHeight - scrollDOM.scrollTop - scrollDOM.clientHeight <=
        STICK_TO_BOTTOM_PX;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: resolvedAnchor },
    });
    if (pinned) {
      scrollDOM.scrollTop = scrollDOM.scrollHeight;
    }
  }

  getContent(): string {
    return this._view?.state.doc.toString() ?? '';
  }

  /**
   * The live-edit lock (ADR-0049): blocks USER input while the assistant
   * edits the document. Only the `editable` facet flips — programmatic
   * `setContent` keeps flowing and each push stays one undo step.
   */
  setEditable(editable: boolean): void {
    this._view?.dispatch({
      effects: this.editLockCompartment.reconfigure(editable ? [] : EditorView.editable.of(false)),
    });
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
   *
   * The value is also stashed: switching *from* a code tab back to Markdown
   * re-adds the fold `StateField` a beat after the owner replays the state
   * (the language compartment reconfigures in this component's own effect,
   * which runs after the owner's), so `applyLanguage` re-asserts it.
   */
  setFrontmatterExpanded(expanded: boolean): void {
    this.desiredFrontmatterExpanded = expanded;
    const view = this._view;
    if (view && frontmatterExpandedOf(view.state) !== expanded) {
      view.dispatch({ effects: setFrontmatterExpanded.of(expanded) });
    }
  }

  private modeExtensions(mode: EditorViewMode): Extension {
    return mode === 'live'
      ? livePreview({
          resolveImage: (url) =>
            resolveVaultImageCandidates(this.editor.openPath(), url, this.editor.openVaultId()),
          onOpenImage: (src) => this.lightbox.open(src),
          onZoomDiagram: (dataUrl) => this.lightbox.open(dataUrl),
          // The PDF embed's lens opens the file as a full PDF tab.
          onOpenPdf: (src) => {
            const target = assetUrlToVaultPath(src);
            if (target) {
              void this.editor.openFile(target.path, target.vaultId ?? undefined);
            }
          },
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
 * Shows the line-number column and restyles it to the v3 spec: 46px column,
 * Plex Mono 10.5, right-aligned. Mounted in a compartment gated on the meta
 * bar's "Lines" toggle; `editorStructure` hides `.cm-lineNumbers` by
 * default, this re-shows it. `Prec.high` so it beats `editorStructure` on
 * equal specificity. No extra `lineNumbers()` extension -- `basicSetup`
 * already provides one. (The fold-chevron column is always-on in
 * `editorStructure`, independent of this toggle.)
 */
const gutterTheme: Extension = Prec.high(
  EditorView.theme({
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: 'none',
      color: 'var(--gutter)',
    },
    '.cm-lineNumbers': { display: 'flex !important' },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '46px',
      padding: '0 14px 0 6px',
      fontFamily: 'var(--font-mono)',
      fontSize: 'calc(10.5px * var(--drey-editor-scale, 1))',
      // CodeMirror sizes each gutter row to its line's measured pixel
      // height but does NOT copy the content's line-height, so the number
      // glyph would inherit the unitless `1.72` from `.cm-scroller` and
      // re-multiply it against this 10.5px font -- a short inline box that
      // floats near the top of a ~25px body row (worse on a heading line).
      // Pin it to the body line-box height and top-align the digits so they
      // sit level with the first visual row of any line (heading, wrapped).
      lineHeight: 'calc(14.5px * 1.72 * var(--drey-editor-scale, 1))',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
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
  // No gutter at all on a compact surface (entry drawer, assistant
  // composer): `basicSetup` mounts line-number + fold gutters and
  // `editorStructure` now makes the fold column always-on, but a one-line
  // composer has nothing to number or fold.
  '.cm-gutters': { display: 'none' },
});
