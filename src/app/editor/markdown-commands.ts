import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state';
import { copyLineDown } from '@codemirror/commands';

/**
 * Editor commands specific to Markdown notes that CodeMirror does not ship.
 * Wired to the Selection menu (`MenuService`) and, where a chord makes
 * sense, to the surface keymap.
 */

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]\s/;
const LIST_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/**
 * Toggle the checkbox state of every line the selection touches:
 * `- [ ] …` <-> `- [x] …`. A bare list item (`- …`) gains an unchecked
 * box; any other line is turned into `- [ ] …`.
 */
export const toggleTaskDone: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const firstLine = state.doc.lineAt(range.from).number;
    const lastLine = state.doc.lineAt(range.to).number;
    for (let n = firstLine; n <= lastLine; n++) {
      if (seen.has(n)) {
        continue;
      }
      seen.add(n);
      const line = state.doc.line(n);
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
  dispatch(
    state.update({
      changes,
      scrollIntoView: true,
      userEvent: 'input.toggleTask',
    }),
  );
  return true;
};

/**
 * Duplicate the current selection in place. With an empty selection this
 * falls back to CodeMirror's "copy line down".
 */
export const duplicateSelection: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (state.selection.ranges.every((range) => range.empty)) {
    return copyLineDown(target);
  }

  const changes: ChangeSpec[] = [];
  const ranges = [];
  for (const range of state.selection.ranges) {
    const text = state.sliceDoc(range.from, range.to);
    changes.push({ from: range.to, insert: text });
    ranges.push(EditorSelection.range(range.to, range.to + text.length));
  }
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: 'input.duplicateSelection',
    }),
  );
  return true;
};
