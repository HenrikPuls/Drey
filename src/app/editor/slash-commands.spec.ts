import type { CompletionContext } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { makeSlashCommandSource, slashCommandSource, SLASH_COMMANDS } from './slash-commands';

interface ResultLike {
  from: number;
  options: Array<{
    label: string;
    apply?: (view: EditorView, completion: unknown, from: number, to: number) => void;
  }>;
}

/** A CompletionContext stand-in over a real Markdown state (word-completion
 * spec's pattern): `matchBefore` mirrors the real implementation. */
function ctx(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return {
    state,
    pos,
    explicit,
    matchBefore: (regexp: RegExp) => {
      const line = state.doc.lineAt(pos);
      const before = state.sliceDoc(line.from, pos);
      const match = regexp.exec(before);
      if (!match || match.index + match[0].length < before.length) {
        return null;
      }
      return { from: line.from + match.index, to: pos, text: match[0] };
    },
  } as unknown as CompletionContext;
}

describe('the Entry block (makeSlashCommandSource)', () => {
  const ENTRY = '## 09:41\n';
  const source = makeSlashCommandSource({ entryText: () => ENTRY }) as (
    c: CompletionContext,
  ) => (ResultLike & { options: Array<{ section?: { name: string }; info?: () => Node }> }) | null;

  it('leads the menu in the Templates section, formatting follows', () => {
    const result = source(ctx('/', 1));
    expect(result?.options[0].label).toBe('Entry');
    expect(result?.options[0].section?.name).toBe('Templates');
    expect(result?.options[1].section?.name).toBe('Formatting');
  });

  it('is found by its name and absent for other queries', () => {
    expect(source(ctx('/ent', 4))?.options.map((o) => o.label)).toEqual(['Entry']);
    expect(source(ctx('/head', 5))?.options.map((o) => o.label)).not.toContain('Entry');
  });

  it('previews the block and inserts it in place of the typed slash', () => {
    const result = source(ctx('/', 1));
    const card = result!.options[0].info!() as HTMLElement;
    expect(card.querySelector('.slash-preview-body')?.textContent).toBe(ENTRY);

    const view = new EditorView({
      state: EditorState.create({ doc: 'intro\n/ent', extensions: [markdown({ base: markdownLanguage })] }),
    });
    try {
      result!.options[0].apply!(view, null, 6, 10);
      expect(view.state.doc.toString()).toBe('intro\n## 09:41\n');
      // The caret waits right after the time, where the topic goes.
      expect(view.state.selection.main.head).toBe(6 + '## 09:41'.length);
    } finally {
      view.destroy();
    }
  });

  it('offers no Entry without the composer (plain source)', () => {
    const plain = slashCommandSource as (c: CompletionContext) => ResultLike | null;
    expect(plain(ctx('/', 1))?.options.map((o) => o.label)).not.toContain('Entry');
  });
});

describe('slashCommandSource', () => {
  const source = slashCommandSource as (c: CompletionContext) => ResultLike | null;

  it('opens on a bare slash at a line start', () => {
    const result = source(ctx('/ hello', 1));
    expect(result?.from).toBe(0);
    expect(result?.options.map((o) => o.label)).toContain('Heading 1');
  });

  it('opens after whitespace and filters by the typed query', () => {
    const doc = 'words /head';
    const result = source(ctx(doc, doc.length));
    expect(result?.options.map((o) => o.label)).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
  });

  it('stays silent after a non-space character (urls, paths, and/or, dates)', () => {
    expect(source(ctx('see https://x', 13))).toBeNull();
    expect(source(ctx('and/or', 6))).toBeNull();
    expect(source(ctx('2026/10', 7))).toBeNull();
    expect(source(ctx('./bin/x', 7))).toBeNull();
  });

  it('stays silent inside code, frontmatter and links', () => {
    expect(source(ctx('```\n/x\n```', 6))).toBeNull();
    expect(source(ctx('---\nkey: /x\n---\n', 11))).toBeNull();
    expect(source(ctx('[a](/x)', 7))).toBeNull();
  });

  it('offers nothing for a query no label starts with', () => {
    expect(source(ctx('/zzz', 4))).toBeNull();
  });

  it('applying a command removes the slash and formats the line (one undo step)', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'a\n\nb\n',
        selection: { anchor: 2 },
        extensions: [markdown({ base: markdownLanguage })],
      }),
      parent: document.body,
    });
    try {
      // Simulate the user having typed `/head` on the empty line and
      // picking "Heading 2".
      view.dispatch({
        changes: { from: 2, insert: '/head' },
        selection: { anchor: 7 },
      });
      const result = source(ctx(view.state.doc.toString(), 7));
      const heading2 = result?.options.find((o) => o.label === 'Heading 2');
      expect(heading2).toBeTruthy();
      // The real completion `apply` signature is (view, completion, from, to).
      heading2!.apply!(view, {} as never, result!.from, 7);

      expect(view.state.doc.toString()).toBe('a\n## \nb\n');
      expect(view.state.selection.main.head).toBe('a\n## '.length);
    } finally {
      view.destroy();
    }
  });
});

describe('SLASH_COMMANDS', () => {
  it('lists the toolbar block commands plus code block and divider', () => {
    expect(SLASH_COMMANDS.map((c) => c.label)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'Task list',
      'Blockquote',
      'Code block',
      'Table',
      'Divider',
      'Link',
    ]);
  });
});
