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

/** What the extension needs from the outside world to do its job. */
export interface SpellcheckSource {
  /** Whether checking is switched on at all right now. */
  enabled(): boolean;
  /** The misspelled subset of `words`, each with its suggestions. */
  check(words: string[]): Promise<Map<string, readonly string[]>>;
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
interface Flagged {
  from: number;
  to: number;
  word: string;
  suggestions: readonly string[];
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
  provide: (field) => [
    EditorView.decorations.from(field, (state) => state.decorations),
    showTooltip.compute([field], (state) => buildTooltip(state.field(field))),
  ],
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

function buildTooltip(state: SpellState): Tooltip | null {
  const open = state.open;
  if (!open) {
    return null;
  }
  return {
    pos: open.from,
    end: open.to,
    above: false,
    create: (view) => ({ dom: suggestionDom(view, open) }),
  };
}

function suggestionDom(view: EditorView, issue: Flagged): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-spell-popup';

  const head = document.createElement('div');
  head.className = 'cm-spell-popup-word';
  head.textContent = issue.word;
  dom.appendChild(head);

  if (issue.suggestions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cm-spell-popup-empty';
    empty.textContent = 'No suggestions';
    dom.appendChild(empty);
    return dom;
  }

  for (const suggestion of issue.suggestions) {
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
    dom.appendChild(button);
  }
  return dom;
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
      view.dispatch({ effects: openPopup.of(hit) });
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
        let issues: Map<string, readonly string[]>;
        try {
          issues = await config.source.check(distinctWords(spans));
        } catch {
          // A dictionary that is unreachable clears the underlines rather
          // than freezing the last verdict onto text that has since changed.
          this.publish(token, []);
          return;
        }
        this.publish(
          token,
          issueSpans(spans, issues).map((span) => ({
            from: span.from,
            to: span.to,
            word: span.word,
            suggestions: span.suggestions,
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
});

/** The inline spellchecker: underlines, click popup, and the check loop. */
export function inlineSpellcheck(config: SpellcheckConfig): Extension {
  return [spellState, clickHandler, checker(config), spellcheckTheme];
}

/**
 * Re-runs the check even though the text did not change -- call it when
 * whatever gates `SpellcheckSource.enabled()` has flipped, otherwise the
 * underlines only appear after the user's next keystroke.
 */
export function requestSpellcheck(view: EditorView): void {
  view.dispatch({ effects: recheck.of(null) });
}

/** Test seam: the words a view currently has flagged, in document order. */
export function flaggedWords(view: EditorView): ReadonlyArray<{ from: number; word: string }> {
  return view.state.field(spellState, false)?.flagged ?? [];
}
