/**
 * The `Mod+Enter` checkbox toggle (was `src/app/editor/markdown-commands.ts`
 * `toggleTaskDone`): flips the checkbox of every line the selection
 * touches, upgrades a bare list item to a checkbox, and turns any other
 * non-empty line into a checkbox item.
 *
 * Built from the HOST's CodeMirror module instances only (`api.editor.cm`,
 * ADR-0044 rule 1); the @codemirror imports below are type-only.
 */
import type { ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CodeMirrorModules } from '../../../shared/plugin-api/renderer';
import { syncCompletionDateOnLineText } from '../shared/tasks.js';

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]\s/;
const LIST_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/** The surface the user focused last -- the Selection-menu row targets it. */
let focusedView: EditorView | null = null;

/**
 * The extension: the `Mod+Enter` keymap plus a focus tracker so the
 * Selection-menu row can act on the surface the user last had focused
 * (the same "EditTargetService last saw focused" semantics the base menu
 * row had).
 */
export function taskToggleExtension(cm: CodeMirrorModules): unknown {
  const trackFocus = cm.view.EditorView.domEventHandlers({
    focus: (_event, view) => {
      focusedView = view;
      return false;
    },
  });
  const modEnter = cm.view.keymap.of([
    { key: 'Mod-Enter', run: (view) => toggleTaskDone(cm, view) },
  ]);
  return [trackFocus, modEnter, completionDateSync(cm)];
}

/**
 * Keeps the completion date in step with every editor checkbox toggle
 * (57d): `Mod+Enter` here and the base Live Preview checkbox click both
 * tag their transaction `input.toggleTask…`; this filter appends the
 * `✅ today` stamp (or its removal) to that same transaction, so the flip
 * and the date are one undo step — the same line shape the Tasks panel's
 * row toggle writes through `setDoneOnLine`.
 */
function completionDateSync(cm: CodeMirrorModules): unknown {
  return cm.state.EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent('input.toggleTask')) {
      return tr;
    }
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const first = tr.newDoc.lineAt(fromB).number;
      const last = tr.newDoc.lineAt(toB).number;
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) {
          continue;
        }
        seen.add(n);
        const line = tr.newDoc.line(n);
        const next = syncCompletionDateOnLineText(line.text);
        if (next === line.text) {
          continue;
        }
        // The minimal splice, so the caret keeps its place on the line.
        let prefix = 0;
        const max = Math.min(line.text.length, next.length);
        while (prefix < max && line.text[prefix] === next[prefix]) {
          prefix++;
        }
        let suffix = 0;
        while (
          suffix < max - prefix &&
          line.text[line.text.length - 1 - suffix] === next[next.length - 1 - suffix]
        ) {
          suffix++;
        }
        changes.push({
          from: line.from + prefix,
          to: line.to - suffix,
          insert: next.slice(prefix, next.length - suffix),
        });
      }
    });
    return changes.length === 0 ? tr : [tr, { changes, sequential: true }];
  });
}

/** Toggles the task boxes on the selected line(s) of `view`. */
export function toggleTaskDone(cm: CodeMirrorModules, view: EditorView): boolean {
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const firstLine = view.state.doc.lineAt(range.from).number;
    const lastLine = view.state.doc.lineAt(range.to).number;
    for (let n = firstLine; n <= lastLine; n++) {
      if (seen.has(n)) {
        continue;
      }
      seen.add(n);
      const line = view.state.doc.line(n);
      const task = TASK_RE.exec(line.text);
      if (task) {
        const boxStart = line.from + task[1].length + 1;
        const checked = task[2] === ' ' ? 'x' : ' ';
        changes.push({ from: boxStart, to: boxStart + 1, insert: checked });
        continue;
      }
      const list = LIST_RE.exec(line.text);
      if (list) {
        const insertAt = line.from + list[1].length;
        changes.push({ from: insertAt, insert: '[ ] ' });
        continue;
      }
      if (line.text.trim() === '') {
        continue;
      }
      changes.push({ from: line.from, insert: '- [ ] ' });
    }
  }

  if (changes.length === 0) {
    return false;
  }
  view.dispatch(
    view.state.update({
      changes,
      scrollIntoView: true,
      userEvent: 'input.toggleTask',
    }),
  );
  return true;
}

/** The Selection-menu row: act on the last focused surface, if any. */
export function toggleInFocusedSurface(cm: CodeMirrorModules): boolean {
  return focusedView !== null && toggleTaskDone(cm, focusedView);
}
