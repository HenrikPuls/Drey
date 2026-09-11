import { EditorState, Transaction } from '@codemirror/state';
import { duplicateSelection } from './markdown-commands';

/**
 * Base Markdown editor commands. (`toggleTaskDone` moved to the Tasks
 * plugin at the ADR-0044 stage-6 conversion -- its spec lives with the
 * plugin's logic under `src/app/services/plugin-tasks-*`.)
 */

/** Runs a StateCommand against a doc/selection and returns the resulting text. */
function run(
  command: typeof duplicateSelection,
  doc: string,
  anchor: number,
  head: number = anchor,
): { text: string; handled: boolean } {
  const state = EditorState.create({ doc, selection: { anchor, head } });
  let next = state;
  const handled = command({
    state,
    dispatch: (tr: Transaction) => {
      next = tr.state;
    },
  });
  return { text: next.doc.toString(), handled };
}

describe('duplicateSelection', () => {
  it('duplicates a non-empty selection in place', () => {
    expect(run(duplicateSelection, 'abcdef', 1, 4).text).toBe('abcdbcdef');
  });

  it('falls back to copy-line-down for an empty selection', () => {
    expect(run(duplicateSelection, 'one\ntwo', 1).text).toBe('one\none\ntwo');
  });
});
