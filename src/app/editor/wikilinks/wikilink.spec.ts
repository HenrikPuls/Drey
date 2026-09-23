import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import {
  extractWikilinks,
  makeWikilinkCompletionSource,
  wikilinkDecorations,
  type WikilinkCandidate,
} from './wikilink';

describe('extractWikilinks', () => {
  it('parses a plain [[target]]', () => {
    const [occ] = extractWikilinks('see [[Boat purchase]] now');
    expect(occ).toMatchObject({ target: 'Boat purchase', anchor: null, alias: null });
    expect('see [[Boat purchase]] now'.slice(occ!.index, occ!.index + occ!.length)).toBe(
      '[[Boat purchase]]',
    );
  });

  it('parses target, #anchor and |alias in every combination', () => {
    expect(extractWikilinks('[[note]]')[0]).toMatchObject({
      target: 'note',
      anchor: null,
      alias: null,
    });
    expect(extractWikilinks('[[note#Sec 2]]')[0]).toMatchObject({
      target: 'note',
      anchor: 'Sec 2',
      alias: null,
    });
    expect(extractWikilinks('[[note|my alias]]')[0]).toMatchObject({
      target: 'note',
      anchor: null,
      alias: 'my alias',
    });
    expect(extractWikilinks('[[note#Sec 2|alias]]')[0]).toMatchObject({
      target: 'note',
      anchor: 'Sec 2',
      alias: 'alias',
    });
  });

  it('keeps a same-file [[#heading]] anchor with an empty target', () => {
    expect(extractWikilinks('[[#Next Steps]]')[0]).toMatchObject({
      target: '',
      anchor: 'Next Steps',
      alias: null,
    });
  });

  it('lets the target contain folders, dots and spaces', () => {
    expect(extractWikilinks('[[daily/2026/09/2026-09-12.md]]')[0]?.target).toBe(
      'daily/2026/09/2026-09-12.md',
    );
  });

  it('skips [[]] and [[|alias]] (no target, no anchor)', () => {
    expect(extractWikilinks('[[]]')).toEqual([]);
    expect(extractWikilinks('[[|alias]]')).toEqual([]);
  });

  it('rejects nested brackets in the target', () => {
    expect(extractWikilinks('[[a]b]]')).toEqual([]);
  });

  it('finds several links and reports the alias offsets', () => {
    const text = '[[one]] and [[two#h|t]]';
    const occs = extractWikilinks(text);
    expect(occs.map((o) => o.target)).toEqual(['one', 'two']);
    const second = occs[1];
    // content ends before the `|`; the alias starts right after it
    expect(text.slice(second.index, second.index + second.contentEnd)).toBe('[[two#h');
    expect(text.slice(second.index + second.aliasStart, second.index + second.length - 2)).toBe(
      't',
    );
  });
});

const MARKS = { extensions: [markdown({ base: markdownLanguage })] };

function marks(
  doc: string,
  resolve: (target: string) => boolean = () => true,
): { from: number; to: number; cls: string; attrs: Record<string, string> }[] {
  const state = EditorState.create({ doc, extensions: MARKS.extensions });
  const set: DecorationSet = wikilinkDecorations(state, [{ from: 0, to: state.doc.length }], resolve);
  const out: { from: number; to: number; cls: string; attrs: Record<string, string> }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    out.push({
      from,
      to,
      cls: deco.spec['class'] as string,
      attrs: deco.spec['attributes'] as Record<string, string>,
    });
  });
  return out;
}

describe('wikilinkDecorations', () => {
  it('marks the whole [[...]] span with the resolved class and data attributes', () => {
    const doc = 'link to [[Plan]] here';
    const [hit] = marks(doc);
    expect(doc.slice(hit!.from, hit!.to)).toBe('[[Plan]]');
    expect(hit!.cls).toBe('cm-wikilink');
    expect(hit!.attrs['data-wikilink']).toBe('Plan');
  });

  it('carries anchor and alias as data attributes', () => {
    const [hit] = marks('[[note#Head|al]]');
    expect(hit!.attrs).toEqual({
      'data-wikilink': 'note',
      'data-anchor': 'Head',
      'data-alias': 'al',
    });
  });

  it('uses the unresolved class when resolve misses', () => {
    const [hit] = marks('[[Missing]]', () => false);
    expect(hit!.cls).toBe('cm-wikilink cm-wikilink-unresolved');
  });

  it('does not mark inside a fenced code block or inline code', () => {
    expect(marks('```\n[[a]]\n```')).toEqual([]);
    expect(marks('a `[[b]]` c')).toEqual([]);
  });

  it('does not mark inside frontmatter', () => {
    const doc = '---\ntitle: "[[x]]"\n---\n\n[[real]]';
    const hits = marks(doc);
    expect(hits).toHaveLength(1);
    expect(doc.slice(hits[0]!.from, hits[0]!.to)).toBe('[[real]]');
  });
});

const NOTES: WikilinkCandidate[] = [
  { name: 'plan', path: 'notes/plan.md', dir: 'notes', target: 'plan' },
  { name: 'journal', path: 'daily/journal.md', dir: 'daily', target: 'daily/journal' },
  { name: 'journal', path: 'journal.md', dir: '', target: 'journal.md' },
];

interface ResultLike {
  from: number;
  options: Array<{ label: string; apply?: string; detail?: string; boost?: number }>;
  validFor?: RegExp;
}

function ctx(
  doc: string,
  pos: number,
  match: { from: number; to: number; text: string } | null,
  explicit = false,
) {
  const state = EditorState.create({ doc, extensions: MARKS.extensions });
  return { state, pos, explicit, matchBefore: () => match } as unknown as CompletionContext;
}

describe('makeWikilinkCompletionSource', () => {
  const source = makeWikilinkCompletionSource(() => NOTES) as (
    c: CompletionContext,
  ) => ResultLike | null;

  it('offers basename prefix matches and inserts [[target]]', () => {
    const result = source(ctx('[[pl', 4, { from: 0, to: 4, text: '[[pl' }));
    expect(result?.from).toBe(0);
    expect(result?.options).toHaveLength(1);
    expect(result?.options[0]).toMatchObject({ label: 'plan', apply: '[[plan]]' });
    expect(result?.options[0].detail).toBe('notes');
  });

  it('returns null on a bare [[ unless explicitly requested', () => {
    expect(source(ctx('[[', 2, { from: 0, to: 2, text: '[[' }))).toBeNull();
    expect(source(ctx('[[', 2, { from: 0, to: 2, text: '[[' }, true))?.options).toHaveLength(3);
  });

  it('falls back to a substring match on the vault path', () => {
    const result = source(ctx('[[dail', 6, { from: 0, to: 6, text: '[[dail' }));
    expect(result?.options.map((o) => o.label)).toEqual(['journal']);
    expect(result?.options[0].apply).toBe('[[daily/journal]]');
  });

  it('returns null when nothing matches or there is no token', () => {
    expect(source(ctx('[[zzz', 5, { from: 0, to: 5, text: '[[zzz' }))).toBeNull();
    expect(source(ctx('', 0, null))).toBeNull();
  });

  it('stays silent inside code spans, fenced code and frontmatter', () => {
    expect(source(ctx('```\n[[pl\n```', 8, { from: 4, to: 8, text: '[[pl' }))).toBeNull();
    expect(source(ctx('a `[[pl` b', 7, { from: 3, to: 7, text: '[[pl' }))).toBeNull();
    const fm = '---\nref: "[[pl"\n---\n';
    expect(source(ctx(fm, 14, { from: 10, to: 14, text: '[[pl' }))).toBeNull();
  });

  it('keeps the popup open while typing inside the brackets', () => {
    const result = source(ctx('[[pl', 4, { from: 0, to: 4, text: '[[pl' }));
    expect(result?.validFor?.test('[[plan')).toBe(true);
    expect(result?.validFor?.test('[[pl an')).toBe(true); // spaces are legal in targets
    // `#` (anchor) / `|` (alias) end the name query -- the popup closes.
    expect(result?.validFor?.test('[[pl#Head')).toBe(false);
    expect(result?.validFor?.test('[[pl|x')).toBe(false);
  });
});
