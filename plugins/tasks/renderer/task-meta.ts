/**
 * Task-line metadata completion AND click-to-change (req-37): on a
 * checkbox or `#task` line, the trigger words `due` / `fällig` offer date
 * tokens (`📅 YYYY-MM-DD`, Obsidian-Tasks compatible) and `prio` /
 * `priority` offer the three priority glyphs. Tokens already on a line are
 * decorated as chips and a plain mouse click on one re-opens the picker —
 * the date popover (native `<input type="date">`, current date prefilled)
 * or the glyph menu — replacing the token in place.
 *
 * Both pickers share one implementation: an anchor point in viewport
 * coordinates plus an `onCommit(value)` callback, so the editor (dispatch
 * over the token range) and the Tasks panel (write-back through the
 * panel's task routing) host the same popover.
 *
 * The completion source rides the host's markdown language data (the same
 * seam the base uses for tag / wikilink / word completion, so the popups
 * merge), and guards like the scanner: frontmatter and fenced code never
 * trigger. Built from the HOST's CodeMirror module instances only
 * (`api.editor.cm`, ADR-0044 rule 1); the @codemirror imports below are
 * type-only.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import type { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { CodeMirrorModules } from '../../../shared/plugin-api/renderer';
import {
  type TaskPriority,
  dueState,
  glyphOfPriority,
  isTaskLine,
  taskLineTokens,
  todayIso,
} from '../shared/tasks.js';

/** The trigger words, matched against the word before the caret. */
const DUE_TRIGGER = /^(due|fällig)$/i;
const PRIORITY_TRIGGER = /^(prio|priority)$/i;
/** A due token already on the line (a "remove" option is offered then). */
const DUE_ON_LINE = /(^|\s)📅[ \t]+\d{4}-\d{2}-\d{2}(?=\s|$)/u;
/** A priority glyph already on the line. */
const PRIORITY_ON_LINE = /(^|\s)[🔺⏫🔽](?=\s|$)/u;

/** `YYYY-MM-DD` `days` from today (local timezone). */
function isoOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return todayIso(date);
}

/** True when `lineNumber` (1-based) sits inside a leading `---` frontmatter block. */
function inFrontmatter(
  state: { doc: { lines: number; line(n: number): { text: string } } },
  lineNumber: number,
): boolean {
  if (lineNumber < 1 || state.doc.line(1).text.trim() !== '---') {
    return false;
  }
  for (let n = 2; n <= Math.min(lineNumber, state.doc.lines); n++) {
    if (state.doc.line(n).text.trim() === '---') {
      return lineNumber < n;
    }
  }
  return true; // Unclosed frontmatter: everything after the opener is one.
}

/** True when `lineNumber` sits inside a ``` / ~~~ fence (same toggle the scanner applies). */
function inFence(
  state: { doc: { line(n: number): { text: string } } },
  lineNumber: number,
): boolean {
  let inside = false;
  for (let n = 1; n < lineNumber; n++) {
    if (/^[ \t]*(```|~~~)/.test(state.doc.line(n).text)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Replaces the range with `token` ('' removes it, eating one adjacent
 * separator so no double gap stays behind) and hands focus back.
 */
function applyTokenAt(view: EditorView, from: number, to: number, token: string | null): void {
  if (token === null) {
    let start = from;
    let end = to;
    const after = view.state.doc.sliceString(to, Math.min(to + 1, view.state.doc.length));
    if (after === ' ' || after === '\t') {
      end = to + 1;
    } else if (from > 0) {
      const before = view.state.doc.sliceString(from - 1, from);
      if (before === ' ' || before === '\t') {
        start = from - 1;
      }
    }
    view.dispatch({ changes: { from: start, to: end, insert: '' }, selection: { anchor: start } });
    view.focus();
    return;
  }
  view.dispatch({ changes: { from, to, insert: token }, selection: { anchor: from + token.length } });
  view.focus();
}

/** The completion source; registered through `markdownLanguage.data.of`. */
export function taskMetaCompletionSource(context: CompletionContext): CompletionResult | null {
  // Letters only: `.text` is then exactly the typed word and `.from` its
  // start (a `(?:^|\s)…$` pattern would swallow the leading separator into
  // the match and the whole-word trigger test would never fire).
  const word = context.matchBefore(/[\p{L}]+$/u);
  if (word === null) {
    return null;
  }
  const state = context.state;
  const line = state.doc.lineAt(context.pos);
  if (inFrontmatter(state, line.number) || inFence(state, line.number)) {
    return null;
  }
  if (!isTaskLine(line.text)) {
    return null;
  }
  const options: Completion[] = [];
  if (DUE_TRIGGER.test(word.text)) {
    const today = todayIso();
    const tomorrow = isoOffset(1);
    const week = isoOffset(7);
    const replaceWith = (token: string) => (view: EditorView, _c: unknown, from: number, to: number): void => {
      applyTokenAt(view, from, to, token);
    };
    options.push(
      { label: '📅 Today', detail: today, apply: replaceWith(`📅 ${today}`) },
      { label: '📅 Tomorrow', detail: tomorrow, apply: replaceWith(`📅 ${tomorrow}`) },
      { label: '📅 In a week', detail: week, apply: replaceWith(`📅 ${week}`) },
      {
        label: '📅 Pick a date…',
        detail: 'calendar',
        apply: (view, _c, from, to) => {
          openDuePicker(
            anchorOf(view.coordsAtPos(from)),
            null,
            (value) => applyTokenAt(view, from, to, value === null ? null : `📅 ${value}`),
          );
        },
      },
    );
    if (DUE_ON_LINE.test(line.text)) {
      options.push({ label: 'Remove due date', apply: replaceWith('') });
    }
    // `filter: false`: CM would otherwise fuzzy-match the typed trigger
    // against the option LABELS ("📅 Today" vs "due") and drop every
    // option — the whole-word trigger above is the filter here. `validFor`
    // is not allowed alongside it (the source simply re-runs per keystroke).
    return { from: word.from, options, filter: false };
  }
  if (PRIORITY_TRIGGER.test(word.text)) {
    const levels: readonly TaskPriority[] = ['highest', 'high', 'low'];
    for (const level of levels) {
      options.push({
        label: `${glyphOfPriority(level)} ${level[0]!.toUpperCase()}${level.slice(1)}`,
        apply: (view, _c, from, to) => applyTokenAt(view, from, to, glyphOfPriority(level)),
      });
    }
    if (PRIORITY_ON_LINE.test(line.text)) {
      options.push({
        label: 'Normal (remove priority)',
        apply: (view, _c, from, to) => applyTokenAt(view, from, to, ''),
      });
    }
    return { from: word.from, options, filter: false };
  }
  return null;
}

// -- the shared pickers (editor + panel) --------------------------------------

/** Viewport coordinates for a picker (top-left of the popover). */
interface PickerAnchor {
  left: number;
  top: number;
}

/** An open picker's cleanup, or `null` while none is open. */
let openPicker: { cleanup: () => void } | null = null;

/** Removes an open picker, if any (focus handling is the caller's). */
function closePicker(): void {
  openPicker?.cleanup();
  openPicker = null;
}

/** View coords → anchor (null-safe; off-screen fallback when unmapped). */
function anchorOf(coords: { left: number; top: number; bottom: number } | null): PickerAnchor {
  if (coords === null) {
    return { left: 100, top: 100 };
  }
  return { left: coords.left, top: coords.bottom };
}

/** Positions the popover root inside the viewport. */
function placePicker(root: HTMLElement, anchor: PickerAnchor): void {
  root.style.position = 'fixed';
  root.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - 300))}px`;
  root.style.top = `${Math.max(8, Math.min(anchor.top + 6, window.innerHeight - 90))}px`;
}

/** Shared chrome: outside-click + Escape close, mount, focus the first field. */
function mountPicker(root: HTMLElement, anchor: PickerAnchor, focus: HTMLElement): () => void {
  const onDown = (event: MouseEvent): void => {
    if (!root.contains(event.target as Node)) {
      closePicker();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  };
  document.addEventListener('mousedown', onDown, true);
  root.addEventListener('keydown', onKey);
  root.classList.add('tasks-picker');
  placePicker(root, anchor);
  document.body.appendChild(root);
  openPicker = {
    cleanup: () => {
      document.removeEventListener('mousedown', onDown, true);
      root.remove();
    },
  };
  focus.focus();
  return closePicker;
}

/**
 * The due-date picker: a native `<input type="date">`, `current` prefilled
 * (today when null), Apply commits the chosen date (null when the field
 * was cleared) and Cancel closes untouched.
 */
export function openDuePicker(
  anchor: PickerAnchor,
  current: string | null,
  onCommit: (value: string | null) => void,
): void {
  closePicker();
  const root = document.createElement('div');
  root.className = 'tasks-due-picker';
  const field = document.createElement('input');
  field.type = 'date';
  field.value = current ?? todayIso();
  field.setAttribute('aria-label', 'Due date');
  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'apply';
  applyButton.textContent = 'Apply';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'cancel';
  cancelButton.textContent = 'Cancel';
  const commit = (): void => {
    closePicker();
    onCommit(field.value === '' ? null : field.value);
  };
  applyButton.addEventListener('click', commit);
  cancelButton.addEventListener('click', () => closePicker());
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  root.append(field, applyButton, cancelButton);
  mountPicker(root, anchor, field);
  // Open the native calendar dropdown right away (Chromium; needs the
  // user activation the click/completion apply just spent). If that fails
  // (no transient activation in some entry paths), ONE first interaction
  // with the field retries it -- after a date was chosen nothing re-opens
  // by itself, only the native icon / field click does.
  const withPicker = field as HTMLInputElement & { showPicker?: () => void };
  let opened = false;
  try {
    withPicker.showPicker?.();
    opened = true;
  } catch {
    // Retried below on the first interaction.
  }
  if (!opened) {
    field.addEventListener(
      'pointerdown',
      () => {
        try {
          withPicker.showPicker?.();
        } catch {
          // Still refused: the plain field works on its own.
        }
      },
      { once: true },
    );
  }
}

const PRIORITY_LEVELS: readonly TaskPriority[] = ['highest', 'high', 'low'];

/**
 * The priority picker: one button per glyph level plus "Normal" (removes
 * the token). Commits the chosen level (null for normal).
 */
export function openPriorityPicker(
  anchor: PickerAnchor,
  onCommit: (value: TaskPriority | null) => void,
): void {
  closePicker();
  const root = document.createElement('div');
  root.className = 'tasks-prio-picker';
  for (const level of PRIORITY_LEVELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${glyphOfPriority(level)} ${level[0]!.toUpperCase()}${level.slice(1)}`;
    button.addEventListener('click', () => {
      closePicker();
      onCommit(level);
    });
    root.appendChild(button);
  }
  const normal = document.createElement('button');
  normal.type = 'button';
  normal.className = 'normal';
  normal.textContent = 'Normal (remove priority)';
  normal.addEventListener('click', () => {
    closePicker();
    onCommit(null);
  });
  root.appendChild(normal);
  mountPicker(root, anchor, root.querySelector('button') ?? normal);
}

// -- the editor extension ------------------------------------------------------

/** Builds the token chip decorations for the whole document. */
function buildDecorations(
  cm: CodeMirrorModules,
  state: EditorState,
): DecorationSet {
  const builder = new cm.state.RangeSetBuilder<Decoration>();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!isTaskLine(line.text) || inFrontmatter(state, n) || inFence(state, n)) {
      continue;
    }
    for (const span of taskLineTokens(line.text)) {
      const cls =
        span.kind === 'due'
          ? `cm-task-due ${dueState(span.value)}`
          : `cm-task-prio prio-${span.value}`;
      builder.add(line.from + span.from, line.from + span.to, cm.view.Decoration.mark({ class: cls }));
    }
  }
  return builder.finish();
}

/**
 * The editor extension: the completion source on the host's markdown
 * language, the token chips as mark decorations, and the plain-click
 * handler that re-opens the matching picker on a token (the click's caret
 * move is prevented — keyboard navigation still reaches inside).
 */
export function taskMetaExtension(cm: CodeMirrorModules): unknown {
  const decorations = cm.state.StateField.define<DecorationSet>({
    create: (state) => buildDecorations(cm, state),
    update: (value, tr) => (tr.docChanged ? buildDecorations(cm, tr.state) : value),
    provide: (field) => cm.view.EditorView.decorations.from(field),
  });
  const clicks = cm.view.EditorView.domEventHandlers({
    mousedown: (event, view) => {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        return false;
      }
      const line = view.state.doc.lineAt(pos);
      for (const span of taskLineTokens(line.text)) {
        // A click ON the token's pixels opens its picker. The position
        // alone cannot decide this: the end boundary (`offset == span.to`)
        // is shared by the token's right half AND the empty space behind
        // it -- and a one-code-unit glyph would lose half its clicks to an
        // inclusive/exclusive end test. The token's screen width decides:
        // a click inside it opens; a click beside it (even the trailing
        // whitespace of a line-ending token) places the caret normally.
        const startCoords = view.coordsAtPos(line.from + span.from, -1);
        const endCoords = view.coordsAtPos(line.from + span.to, 1);
        if (startCoords === null || endCoords === null) {
          return false;
        }
        if (
          event.clientY < startCoords.top - 2 ||
          event.clientY > endCoords.bottom + 2 ||
          event.clientX < startCoords.left ||
          event.clientX >= endCoords.left + 1
        ) {
          continue;
        }
        event.preventDefault();
        const from = line.from + span.from;
        const to = line.from + span.to;
        const anchor = anchorOf(view.coordsAtPos(from));
        if (span.kind === 'due') {
          openDuePicker(anchor, span.value, (value) => applyTokenAt(view, from, to, value === null ? null : `📅 ${value}`));
        } else {
          openPriorityPicker(anchor, (value) => applyTokenAt(view, from, to, value === null ? null : glyphOfPriority(value)));
        }
        return true;
      }
      return false;
    },
  });
  return [
    cm.langMarkdown.markdownLanguage.data.of({ autocomplete: taskMetaCompletionSource }),
    decorations,
    clicks,
  ];
}
