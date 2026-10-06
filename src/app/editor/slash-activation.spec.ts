import { autocompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { slashCommandSource } from './slash-commands';
import { makeWordCompletionSource } from './word-completion';

/**
 * Activation regression tests: a REAL EditorView with the real
 * autocompletion machinery. The unit spec stubs `CompletionContext` and
 * cannot see activation problems -- the `filter: false` requirement (the
 * popup opens even though no label contains the `/` query) only shows
 * here. Autocompletion only activates on transactions carrying a user
 * event, so every typed dispatch sets `userEvent: 'input.type'`.
 */
describe('slash dialog activation (real view)', () => {
  function type(view: EditorView, text: string): void {
    for (const ch of text) {
      view.dispatch({
        changes: { from: view.state.selection.main.head, insert: ch },
        selection: { anchor: view.state.selection.main.head + 1 },
        userEvent: 'input.type',
      });
    }
  }

  function mount(doc: string, caret: number, source: 'slash' | 'word'): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false }),
          markdownLanguage.data.of({
            autocomplete: source === 'slash' ? slashCommandSource : makeWordCompletionSource(),
          }),
          autocompletion({ activateOnTyping: true }),
        ],
      }),
      parent: document.body,
    });
  }

  it('opens the popup on a bare slash at an empty line start', async () => {
    const view = mount('a\n\nb\n', 2, 'slash');
    try {
      type(view, '/');
      await new Promise((resolve) => setTimeout(resolve, 200)); // activation delay
      expect(view.dom.querySelector('.cm-tooltip-autocomplete')).toBeTruthy();
    } finally {
      view.destroy();
    }
  });

  it('stays silent for a slash after a word character, then narrows while typing', async () => {
    const view = mount('a\n\nb\n', 2, 'slash');
    try {
      type(view, 'and/o');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(view.dom.querySelector('.cm-tooltip-autocomplete')).toBeNull();

      // Fresh line, `/head` -> only the headings.
      view.dispatch({ selection: { anchor: 0 } });
      type(view, '\n/head');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const items = [
        ...(view.dom.querySelector('.cm-tooltip-autocomplete ul')?.children ?? []),
      ].map((li) => li.textContent ?? '');
      expect(items).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    } finally {
      view.destroy();
    }
  });

  it('control: the word-completion popup opens in this harness (harness sanity)', async () => {
    const view = mount('a\n\nsailing boat\n', 13, 'word');
    try {
      type(view, 'sail');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(view.dom.querySelector('.cm-tooltip-autocomplete')).toBeTruthy();
    } finally {
      view.destroy();
    }
  });
});
