/**
 * Inline spellcheck for CodeMirror 6 (drawer spec): misspelled words get a
 * red wavy underline drawn in the text itself, and clicking one opens a
 * small popup with the dictionary's suggestions -- click a suggestion and
 * it replaces the word.
 *
 * Shape of the thing, and why:
 * - A `StateField` holds the current decorations plus the flagged words.
 *   Decorations must survive and *move with* every edit, which is what
 *   `RangeSet.map` does for free -- recomputing them from scratch on each
 *   keystroke would both flicker and misplace them while a check is in
 *   flight.
 * - Checking is asynchronous (the dictionary lives in the main process,
 *   ADR-0001), so results arrive through a `StateEffect` rather than being
 *   returned. A `ViewPlugin` debounces the request and drops any answer
 *   the document has already moved past.
 * - The verdict check deliberately carries no suggestions: generating
 *   them costs the dictionary tens of milliseconds *per misspelled word*,
 *   which would turn the bulk check after every typing pause into a
 *   main-process stall. They are fetched lazily, one word at a time,
 *   when a flagged word's popup opens (`SpellcheckSource.suggest`), and
 *   the popup fills in place once they arrive.
 * - The popup is CodeMirror's own `showTooltip` facet, not a hand-placed
 *   absolutely-positioned div: it already solves flipping near the window
 *   edge and staying attached while the document scrolls.
 *
 * The extension is deliberately provider-agnostic (`SpellcheckSource`) --
 * it knows nothing about IPC, which keeps it unit-testable and lets the
 * dictionary backend change without touching this file.
 */
import { Extension, StateEffect, StateField, Transaction } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  Tooltip,
  ViewPlugin,
  ViewUpdate,
  showTooltip,
} from '@codemirror/view';
import { collectWords, distinctWords, issueSpans, WordSpan } from '../../../../shared/spellcheck';

/** Which accepted-word list a popup "Add …" action targets. */
export type AddWordTarget = 'language' | 'personal';

/** What the extension needs from the outside world to do its job. */
export interface SpellcheckSource {
  /** Whether checking is switched on at all right now. */
  enabled(): boolean;
  /** The misspelled subset of `words`, as a set of the flagged words. */
  check(words: string[]): Promise<ReadonlySet<string>>;
  /**
   * Suggestions for one misspelled word, fetched when its popup opens --
   * deliberately not part of `check`, where the per-word cost would be
   * paid for every flagged word on every typing pause.
   */
  suggest(word: string): Promise<readonly string[]>;
  /**
   * Adds `word` to an accepted-word list and repaints. Optional -- when
   * absent, the popup shows no "Add to dictionary" rows.
   */
  addWord?(word: string, target: AddWordTarget): Promise<void>;
  /** Human labels for the two "Add …" rows (active dictionary / personal list). */
  wordTargets?(): { language: string; personal: string };
}

export interface SpellcheckConfig {
  source: SpellcheckSource;
  /** Idle time before a changed document is sent to the dictionary. */
  debounceMs?: number;
}

/**
 * Documents up to this size are scanned whole; larger ones only where the
 * reader is looking. Whole-document scanning is what you want -- the
 * squiggle is there the moment you scroll to it, and the syntax masking in
 * `shared/spellcheck.ts` sees complete code fences and frontmatter. But it
 * is O(document) on every typing pause, so past a point the viewport is
 * the honest trade. A long note is tens of KB; this is comfortably above
 * that and well below where the scan would be felt.
 */
const FULL_SCAN_LIMIT = 60_000;

/** One flagged word, as held in the state field. */
export interface Flagged {
  from: number;
  to: number;
  word: string;
}

const setIssues = StateEffect.define<Flagged[]>();
/**
 * Asks for a re-check without the document having changed. The gate a
 * `SpellcheckSource` applies (the drawer's "does this entry have a topic,
 * person or meeting?") can flip while the text sits still, and the plugin
 * has no way to observe that on its own -- the owner dispatches this.
 */
const recheck = StateEffect.define<null>();
const openPopup = StateEffect.define<Flagged>();
/** Closes the popup without touching the underlines. */
const closePopup = StateEffect.define<null>();

const squiggle = Decoration.mark({ class: 'cm-spell-error' });

interface SpellState {
  decorations: DecorationSet;
  /** The flagged words, kept in step with `decorations` through mapping. */
  flagged: readonly Flagged[];
  open: Flagged | null;
}

const spellState = StateField.define<SpellState>({
  create() {
    return { decorations: Decoration.none, flagged: [], open: null };
  },
  update(value, tr) {
    let next = value;

    for (const effect of tr.effects) {
      if (effect.is(setIssues)) {
        next = {
          decorations: Decoration.set(
            effect.value.map((issue) => squiggle.range(issue.from, issue.to)),
            true,
          ),
          flagged: effect.value,
          // A fresh verdict invalidates whatever the popup was showing.
          open: null,
        };
      } else if (effect.is(openPopup)) {
        next = { ...next, open: effect.value };
      } else if (effect.is(closePopup)) {
        next = { ...next, open: null };
      }
    }

    if (tr.docChanged) {
      next = {
        decorations: next.decorations.map(tr.changes),
        flagged: mapFlagged(next.flagged, tr),
        // Any edit moves the text under the popup; re-opening is one click.
        open: null,
      };
    }
    return next;
  },
  // The tooltip provider lives in `inlineSpellcheck` instead, so it can
  // close over `config.source` (for the "Add to dictionary" rows).
  provide: (field) => [EditorView.decorations.from(field, (state) => state.decorations)],
});

function mapFlagged(flagged: readonly Flagged[], tr: Transaction): Flagged[] {
  const out: Flagged[] = [];
  for (const issue of flagged) {
    const from = tr.changes.mapPos(issue.from, 1);
    const to = tr.changes.mapPos(issue.to, -1);
    // A word the edit collapsed or typed into is no longer *that* word;
    // the next check re-flags it if it is still wrong.
    if (to > from && tr.newDoc.sliceString(from, to) === issue.word) {
      out.push({ ...issue, from, to });
    }
  }
  return out;
}

function buildTooltip(state: SpellState, source: SpellcheckSource): Tooltip | null {
  const open = state.open;
  if (!open) {
    return null;
  }
  return {
    pos: open.from,
    end: open.to,
    above: false,
    create: (view) => ({ dom: suggestionDom(view, open, source) }),
  };
}

/** Exported as a test seam; built by `buildTooltip` at runtime. */
export function suggestionDom(
  view: EditorView,
  issue: Flagged,
  source: SpellcheckSource,
): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-spell-popup';

  const head = document.createElement('div');
  head.className = 'cm-spell-popup-word';
  head.textContent = issue.word;
  dom.appendChild(head);

  // Suggestions arrive asynchronously (see `SpellcheckSource.suggest`);
  // the popup opens immediately with a placeholder and is patched in
  // place when they land -- a local fetch, so the gap is one frame to a
  // few tens of milliseconds.
  const body = document.createElement('div');
  body.className = 'cm-spell-popup-body';
  const loading = document.createElement('div');
  loading.className = 'cm-spell-popup-empty';
  loading.textContent = '…';
  body.appendChild(loading);
  dom.appendChild(body);
  void source.suggest(issue.word).then((suggestions) => {
    const current = view.state.field(spellState, false)?.open;
    if (!current || current.from !== issue.from || current.word !== issue.word) {
      return; // closed, or re-opened on a different word meanwhile
    }
    fillSuggestions(view, body, issue, suggestions);
  });

  if (typeof source.addWord === 'function') {
    const targets = source.wordTargets?.() ?? {
      language: 'this dictionary',
      personal: 'personal words',
    };
    const sep = document.createElement('div');
    sep.className = 'cm-spell-popup-sep';
    dom.appendChild(sep);
    for (const target of ['language', 'personal'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-spell-popup-add';
      button.textContent = `Add “${issue.word}” to ${targets[target]}`;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        void source.addWord!(issue.word, target).then(() => {
          // Clear the popup and re-run the check now that the verdict
          // cache is stale -- the squiggle disappears without a keystroke.
          view.dispatch({ effects: [closePopup.of(null), recheck.of(null)] });
          view.focus();
        });
      });
      dom.appendChild(button);
    }
  }

  return dom;
}

/** Swaps the popup's loading placeholder for the fetched suggestions. */
function fillSuggestions(
  view: EditorView,
  body: HTMLElement,
  issue: Flagged,
  suggestions: readonly string[],
): void {
  body.textContent = '';
  if (suggestions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cm-spell-popup-empty';
    empty.textContent = 'No suggestions';
    body.appendChild(empty);
    return;
  }
  for (const suggestion of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-spell-popup-item';
    button.textContent = suggestion;
    button.addEventListener('mousedown', (event) => {
      // mousedown, not click: the editor takes the selection back on blur
      // before a click would ever land.
      event.preventDefault();
      applySuggestion(view, issue, suggestion);
    });
    body.appendChild(button);
  }
}

function applySuggestion(view: EditorView, issue: Flagged, replacement: string): void {
  // Re-check the text at the recorded range: the buffer may have moved on
  // since the popup opened, and replacing the wrong span is worse than
  // doing nothing.
  if (view.state.doc.sliceString(issue.from, issue.to) !== issue.word) {
    view.dispatch({ effects: closePopup.of(null) });
    return;
  }
  view.dispatch({
    changes: { from: issue.from, to: issue.to, insert: replacement },
    selection: { anchor: issue.from + replacement.length },
    effects: closePopup.of(null),
  });
  view.focus();
}

/** Click handling: open the popup for a flagged word, close it otherwise. */
const clickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.cm-spell-popup')) {
      return false; // the popup's own buttons handle it
    }
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const state = view.state.field(spellState, false);
    if (pos === null || !state) {
      return false;
    }
    const hit = state.flagged.find((issue) => pos >= issue.from && pos <= issue.to);
    if (hit) {
      openSpellPopup(view, hit);
      return false; // let the caret land where the user clicked
    }
    if (state.open) {
      view.dispatch({ effects: closePopup.of(null) });
    }
    return false;
  },
});

/**
 * Runs the checks. Debounced, and version-guarded: a reply that arrives
 * after the document moved on is discarded rather than painting stale
 * underlines.
 */
function checker(config: SpellcheckConfig) {
  const debounceMs = config.debounceMs ?? 400;

  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private pending = 0;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(recheck))) ||
          // Only matters for a document past FULL_SCAN_LIMIT, where the
          // check follows the viewport.
          (update.viewportChanged && update.view.state.doc.length > FULL_SCAN_LIMIT)
        ) {
          this.schedule();
        }
      }

      destroy(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer);
        }
      }

      private schedule(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.run(), debounceMs);
      }

      private async run(): Promise<void> {
        this.timer = null;
        const token = ++this.pending;

        if (!config.source.enabled()) {
          this.publish(token, []);
          return;
        }
        const spans = this.scan();
        if (spans.length === 0) {
          this.publish(token, []);
          return;
        }
        let misspelled: ReadonlySet<string>;
        try {
          misspelled = await config.source.check(distinctWords(spans));
        } catch {
          // A dictionary that is unreachable clears the underlines rather
          // than freezing the last verdict onto text that has since changed.
          this.publish(token, []);
          return;
        }
        this.publish(
          token,
          issueSpans(spans, misspelled).map((span) => ({
            from: span.from,
            to: span.to,
            word: span.word,
          })),
        );
      }

      /**
       * The words to check, with document offsets. Whole document while it
       * is small enough, otherwise the visible ranges only -- each snapped
       * out to whole lines so a word is never cut in half by the viewport
       * edge.
       */
      private scan(): WordSpan[] {
        const doc = this.view.state.doc;
        if (doc.length <= FULL_SCAN_LIMIT) {
          return collectWords(doc.toString());
        }
        const out: WordSpan[] = [];
        for (const range of this.view.visibleRanges) {
          const from = doc.lineAt(range.from).from;
          const to = doc.lineAt(range.to).to;
          for (const span of collectWords(doc.sliceString(from, to))) {
            out.push({ word: span.word, from: from + span.from, to: from + span.to });
          }
        }
        return out;
      }

      private publish(token: number, flagged: Flagged[]): void {
        if (token !== this.pending) {
          return; // a newer check has already been started
        }
        const current = this.view.state.field(spellState, false);
        if (current && current.flagged.length === 0 && flagged.length === 0) {
          return; // nothing to repaint
        }
        this.view.dispatch({ effects: setIssues.of(flagged) });
      }
    },
  );
}

const spellcheckTheme = EditorView.baseTheme({
  '.cm-spell-error': {
    textDecoration: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: 'var(--spell-error, #c05a5a)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-spell-popup': {
    background: 'var(--bg-input, #2c2a28)',
    border: '1px solid var(--border-strong, rgba(255,255,255,0.08))',
    borderRadius: 'var(--radius, 6px)',
    padding: '4px',
    minWidth: '120px',
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
  },
  '.cm-spell-popup-word': {
    font: '10px var(--font-mono, monospace)',
    color: 'var(--text-6, #6e6862)',
    padding: '2px 7px 4px',
    textDecoration: 'line-through',
  },
  '.cm-spell-popup-item': {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-xs, 4px)',
    padding: '4px 7px',
    font: 'inherit',
    fontSize: '12.5px',
    color: 'var(--text-2, #cfcbc4)',
    cursor: 'pointer',
  },
  '.cm-spell-popup-item:hover': {
    background: 'var(--hover-bg, rgba(255,255,255,0.05))',
    color: 'var(--text-primary, #eae7e1)',
  },
  '.cm-spell-popup-empty': {
    padding: '4px 7px',
    fontSize: '12px',
    color: 'var(--text-6, #6e6862)',
  },
  '.cm-spell-popup-sep': {
    height: '1px',
    margin: '4px 2px',
    background: 'var(--border-strong, rgba(255,255,255,0.08))',
  },
  '.cm-spell-popup-add': {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-xs, 4px)',
    padding: '4px 7px',
    font: 'inherit',
    fontSize: '11.5px',
    color: 'var(--text-4, #9a938b)',
    cursor: 'pointer',
  },
  '.cm-spell-popup-add:hover': {
    background: 'var(--hover-bg, rgba(255,255,255,0.05))',
    color: 'var(--text-primary, #eae7e1)',
  },
});

/** The inline spellchecker: underlines, click popup, and the check loop. */
export function inlineSpellcheck(config: SpellcheckConfig): Extension {
  return [
    spellState,
    showTooltip.compute([spellState], (state) =>
      buildTooltip(state.field(spellState), config.source),
    ),
    clickHandler,
    checker(config),
    spellcheckTheme,
  ];
}

/**
 * Re-runs the check even though the text did not change -- call it when
 * whatever gates `SpellcheckSource.enabled()` has flipped, otherwise the
 * underlines only appear after the user's next keystroke.
 */
export function requestSpellcheck(view: EditorView): void {
  view.dispatch({ effects: recheck.of(null) });
}

/**
 * Opens the suggestion popup for a flagged word. The click handler is the
 * runtime caller; exported alongside `suggestionDom` as a test seam so
 * the async suggestion fill can be driven without jsdom hit-testing.
 */
export function openSpellPopup(view: EditorView, issue: Flagged): void {
  view.dispatch({ effects: openPopup.of(issue) });
}

/** Test seam: the words a view currently has flagged, in document order. */
export function flaggedWords(view: EditorView): ReadonlyArray<{ from: number; word: string }> {
  return view.state.field(spellState, false)?.flagged ?? [];
}
