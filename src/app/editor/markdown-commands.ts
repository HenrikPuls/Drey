import { EditorSelection, type ChangeSpec, type StateCommand } from '@codemirror/state';
import { copyLineDown } from '@codemirror/commands';

/**
 * Editor commands specific to Markdown notes that CodeMirror does not ship.
 * Wired to the Selection menu (`MenuService`) and, where a chord makes
 * sense, to the surface keymap. (The `Mod+Enter` task-checkbox toggle went
 * to the Tasks plugin at the ADR-0044 stage-6 conversion.)
 */

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
