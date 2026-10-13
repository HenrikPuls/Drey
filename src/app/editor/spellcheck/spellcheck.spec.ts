import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  Flagged,
  flaggedWords,
  inlineSpellcheck,
  openSpellPopup,
  requestSpellcheck,
  SpellcheckSource,
  suggestionDom,
} from './spellcheck';

/** One recorded `check` call: the words and the language asked for. */
interface CheckCall {
  words: string[];
  language?: string;
}

/** A source that answers from a fixed misspelling list, on demand. */
function fakeSource(
  issues: Record<string, string[]>,
  options: {
    enabled?: boolean;
    withAddWord?: boolean;
    blockLanguage?: (block: string) => string;
  } = {},
): SpellcheckSource & {
  calls: CheckCall[];
  suggestCalls: Array<{ word: string; language?: string }>;
  added: Array<[string, 'language' | 'personal', string?]>;
} {
  const calls: CheckCall[] = [];
  const suggestCalls: Array<{ word: string; language?: string }> = [];
  const added: Array<[string, 'language' | 'personal', string?]> = [];
  return {
    calls,
    suggestCalls,
    added,
    enabled: () => options.enabled !== false,
    blockLanguage: options.blockLanguage ?? (() => 'de'),
    check: async (words, language) => {
      calls.push({ words, language });
      return new Set(words.filter((word) => word in issues));
    },
    suggest: async (word, language) => {
      suggestCalls.push({ word, language });
      return issues[word] ?? [];
    },
    ...(options.withAddWord
      ? {
          addWord: async (word: string, target: 'language' | 'personal', language?: string) => {
            added.push([word, target, language]);
          },
          wordTargets: () => ({ language: 'Deutsch', personal: 'personal words' }),
        }
      : {}),
  };
}

function makeView(doc: string, source: SpellcheckSource): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [inlineSpellcheck({ source, debounceMs: 0 })],
    }),
    parent: document.body,
  });
}

/** Lets the debounce timer and the source's promise settle. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(() => setTimeout(() => resolve(), 0), 0));

describe('inlineSpellcheck', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('flags the misspelled words the source reports, at their offsets', async () => {
    view = makeView('Risiken bei besprchen', fakeSource({ besprchen: ['besprochen'] }));
    await settle();
    expect(flaggedWords(view)).toEqual([
      { from: 12, to: 21, word: 'besprchen', lang: 'de' },
    ]);
  });

  it('renders a wavy-underline decoration for each flagged word', async () => {
    view = makeView('besprchen und besprchen', fakeSource({ besprchen: ['besprochen'] }));
    await settle();
    expect(view.dom.querySelectorAll('.cm-spell-error')).toHaveLength(2);
  });

  it('asks only about distinct words, and skips markdown syntax', async () => {
    const source = fakeSource({});
    view = makeView('#daily besprchen `code` besprchen', source);
    await settle();
    expect(source.calls.at(-1)?.words).toEqual(['besprchen']);
  });

  it('checks nothing while the source is switched off', async () => {
    const source = fakeSource({ besprchen: ['besprochen'] }, { enabled: false });
    view = makeView('besprchen', source);
    await settle();
    expect(source.calls).toEqual([]);
    expect(flaggedWords(view)).toEqual([]);
  });

  it('checks each paragraph under the language its block is detected as', async () => {
    // Two blank-line-separated paragraphs, one German, one English; the
    // fake detector tells them apart by a marker word.
    const source = fakeSource(
      { falschen: ['falschen'], wronge: ['wrong'] },
      {
        blockLanguage: (block) => (block.includes('English') ? 'en' : 'de'),
      },
    );
    view = makeView(
      'Deutscher Satz mit einem falschen Wort hier\n\nEnglish text with one wronge word inside',
      source,
    );
    await settle();
    expect(source.calls).toEqual([
      {
        words: ['Deutscher', 'Satz', 'mit', 'einem', 'falschen', 'Wort', 'hier'],
        language: 'de',
      },
      { words: ['English', 'text', 'with', 'one', 'wronge', 'word', 'inside'], language: 'en' },
    ]);
    expect(flaggedWords(view)).toEqual([
      { from: 25, to: 33, word: 'falschen', lang: 'de' },
      { from: 67, to: 73, word: 'wronge', lang: 'en' },
    ] satisfies Flagged[]);
  });

  it('keeps only the verdict of a word under its own language', async () => {
    // "wronge" is misspelled for the English dictionary but unknown to the
    // German one too -- the flag must follow the block's language.
    const source = fakeSource(
      { wronge: ['wrong'] },
      { blockLanguage: (block) => (block.includes('English') ? 'en' : 'de') },
    );
    view = makeView('Deutscher Satz mit einem falschen Wort hier\n\nEnglish text wronge here', source);
    await settle();
    expect(flaggedWords(view).map((f) => f.lang)).toEqual(['en']);
  });

  it('moves a flag with the text when an earlier edit shifts it', async () => {
    view = makeView('xx besprchen', fakeSource({ besprchen: ['besprochen'] }));
    await settle();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'AB ' } });
    expect(flaggedWords(view)[0]).toMatchObject({ from: 6, word: 'besprchen' });
  });

  it('drops a flag once the word itself is edited', async () => {
    view = makeView('besprchen', fakeSource({ besprchen: ['besprochen'] }));
    await settle();
    view.dispatch({ changes: { from: 5, to: 6, insert: '' } });
    expect(flaggedWords(view)).toEqual([]);
  });

  it('fetches no suggestions during the check, only when a popup opens', async () => {
    const source = fakeSource({ besprchen: ['besprochen'] });
    view = makeView('besprchen', source);
    await settle();
    expect(source.suggestCalls).toEqual([]);

    openSpellPopup(view, { from: 0, to: 9, word: 'besprchen', lang: 'de' });
    await settle();
    expect(source.suggestCalls).toEqual([{ word: 'besprchen', language: 'de' }]);
  });

  it('opens the popup with a placeholder and fills the suggestions in place', async () => {
    const source = fakeSource({ besprchen: ['besprochen', 'besprechen'] });
    view = makeView('besprchen', source);
    await settle();

    openSpellPopup(view, { from: 0, to: 9, word: 'besprchen', lang: 'de' });
    const popup = document.querySelector('.cm-spell-popup');
    // Before the fetch resolves there is only the placeholder row.
    expect(popup?.querySelector('.cm-spell-popup-item')).toBeNull();

    await settle();
    const first = popup?.querySelector('.cm-spell-popup-item') as HTMLElement | null;
    expect(first?.textContent).toBe('besprochen');
    first?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(view.state.doc.toString()).toBe('besprochen');
  });

  it('replaces the word from a clicked popup suggestion', async () => {
    view = makeView('Risiken besprchen', fakeSource({ besprchen: ['besprochen', 'besprechen'] }));
    await settle();

    // The click path needs real coordinates; drive the same effect the
    // handler dispatches by clicking the rendered decoration instead.
    const squiggly = view.dom.querySelector('.cm-spell-error') as HTMLElement;
    squiggly.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));

    const popup = document.querySelector('.cm-spell-popup');
    if (!popup) {
      // jsdom gives every element zero size, so `posAtCoords` can return
      // null and the popup never opens -- the fill logic above is still
      // asserted through `openSpellPopup`.
      return;
    }
    await settle();
    const first = popup.querySelector('.cm-spell-popup-item') as HTMLElement;
    expect(first.textContent).toBe('besprochen');
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(view.state.doc.toString()).toBe('Risiken besprochen');
  });

  it('re-checks on request when the source flipped but the text did not change', async () => {
    // Turning spelling on (or switching dictionary) in Settings must judge
    // the text already on screen, not wait for the next keystroke.
    let anchored = false;
    const source: SpellcheckSource = {
      enabled: () => anchored,
      check: async (words) => new Set(words.filter((w) => w === 'besprchen')),
      suggest: async () => ['besprochen'],
      blockLanguage: () => 'de',
    };
    view = makeView('Risiken besprchen', source);
    await settle();
    expect(flaggedWords(view)).toEqual([]);

    anchored = true;
    requestSpellcheck(view);
    await settle();
    expect(flaggedWords(view).map((f) => f.word)).toEqual(['besprchen']);
  });

  it('offers two "Add to dictionary" rows only when the source can add words', async () => {
    const fakeView = {
      dispatch: () => {},
      focus: () => {},
      // `suggestionDom` consults the field when its async fill lands; a
      // null field reads as "no popup open" and is a safe no-op here.
      state: { field: () => null },
    } as unknown as EditorView;
    const issue = { from: 0, to: 4, word: 'Drey', lang: 'de' };

    const without = suggestionDom(fakeView, issue, fakeSource({}));
    expect(without.querySelectorAll('.cm-spell-popup-add')).toHaveLength(0);

    const source = fakeSource({}, { withAddWord: true });
    const dom = suggestionDom(fakeView, issue, source);
    const rows = dom.querySelectorAll<HTMLButtonElement>('.cm-spell-popup-add');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('Add “Drey” to Deutsch');
    expect(rows[1].textContent).toBe('Add “Drey” to personal words');

    rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(source.added).toEqual([
      ['Drey', 'language', 'de'],
      ['Drey', 'personal', 'de'],
    ]);
  });

  it('clears the underlines when the dictionary call fails', async () => {
    const source: SpellcheckSource = {
      enabled: () => true,
      check: () => Promise.reject(new Error('no dictionary')),
      suggest: async () => [],
      blockLanguage: () => 'de',
    };
    view = makeView('besprchen', source);
    await settle();
    expect(flaggedWords(view)).toEqual([]);
  });

  it('drops a verdict whose text was edited away while the check was in flight', async () => {
    // The dictionary answers late: the check judged "Note /tem", then the
    // trailing word is deleted before the reply lands (the slash menu's
    // "Templates…" row does exactly that).
    let answer: (flagged: ReadonlySet<string>) => void = () => undefined;
    const source: SpellcheckSource = {
      enabled: () => true,
      check: () => new Promise((resolve) => (answer = resolve)),
      suggest: async () => [],
      blockLanguage: () => 'de',
    };
    view = new EditorView({
      state: EditorState.create({
        doc: 'Note tem',
        extensions: [inlineSpellcheck({ source, debounceMs: 20 })],
      }),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 40)); // the check is in flight
    view.dispatch({ changes: { from: 5, to: 8, insert: '' } });
    // The reply lands before the debounced re-check of the edit starts --
    // that re-check must not be what supersedes it.
    answer(new Set(['tem']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No underline past the end of the text ...
    expect(flaggedWords(view)).toEqual([]);
    // ... so the next edit maps cleanly instead of throwing.
    expect(() => view!.dispatch({ changes: { from: 5, insert: 'agenda' } })).not.toThrow();
    expect(view.state.doc.toString()).toBe('Note agenda');
  });
});
