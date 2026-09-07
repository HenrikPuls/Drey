import { EditorState, Transaction } from '@codemirror/state';
import { duplicateSelection, toggleTaskDone } from './markdown-commands';

/** Runs a StateCommand against a doc/selection and returns the resulting text. */
function run(
  command: typeof toggleTaskDone,
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

describe('toggleTaskDone', () => {
  it('checks an unchecked task line', () => {
    expect(run(toggleTaskDone, '- [ ] buy milk', 3).text).toBe('- [x] buy milk');
  });

  it('unchecks a checked task line', () => {
    expect(run(toggleTaskDone, '- [x] buy milk', 3).text).toBe('- [ ] buy milk');
  });

  it('adds a checkbox to a bare list item', () => {
    expect(run(toggleTaskDone, '- plain item', 4).text).toBe('- [ ] plain item');
  });

  it('turns a non-list line into a task', () => {
    expect(run(toggleTaskDone, 'just text', 2).text).toBe('- [ ] just text');
  });

  it('toggles every line the selection spans, once each', () => {
    const doc = '- [ ] a\n- [ ] b\n- [x] c';
    expect(run(toggleTaskDone, doc, 0, doc.length).text).toBe('- [x] a\n- [x] b\n- [ ] c');
  });

  it('does nothing on a blank line', () => {
    expect(run(toggleTaskDone, '', 0).handled).toBe(false);
  });
});

describe('duplicateSelection', () => {
  it('duplicates a non-empty selection in place', () => {
    expect(run(duplicateSelection, 'abcdef', 1, 4).text).toBe('abcdbcdef');
  });

  it('falls back to copy-line-down for an empty selection', () => {
    expect(run(duplicateSelection, 'one\ntwo', 1).text).toBe('one\none\ntwo');
  });
});
