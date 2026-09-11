import type {
  CodeMirrorModules,
  EditorSurfaceContext,
} from '../../../shared/plugin-api/renderer';
import type { TagEntry } from '../shared/search.js';
import { extractTagOccurrences } from '../shared/tags.js';

/**
 * The tags plugin's editor extensions (ADR-0017, ported from
 * `src/app/editor/tag-complete.ts` + `tag-pill.ts`). Everything is built
 * from the HOST's CodeMirror module instances handed in explicitly
 * (ADR-0044 rule 1) so the factories stay testable with a fake `cm`.
 *
 * The local CM value types are minimal on purpose — the real interfaces are
 * far larger than what the pills use, and the SDK hands the modules over as
 * the host's own (structurally identical) types.
 */

interface DecorationSet {
  range(from: number, to: number): unknown;
}
interface DecorationStatic {
  mark(spec: { class: string; attributes?: Record<string, string> }): DecorationSet;
  set(deco: readonly DecorationSet[], sort: boolean): unknown;
}
interface EditorStateLike {
  sliceDoc(from?: number, to?: number): string;
  doc: { length: number; lineAt(pos: number): { from: number; to: number } };
}
interface NodeLike {
  name: string;
  parent: NodeLike | null;
}
interface CmView {
  Decoration: DecorationStatic;
  EditorView: { theme(spec: Record<string, Record<string, string>>): unknown };
  ViewPlugin: {
    fromClass(
      cls: new (view: {
        state: EditorStateLike;
        visibleRanges: readonly { from: number; to: number }[];
      }) => { decorations: unknown },
      spec: {
        decorations: (v: { decorations: unknown }) => unknown;
        eventHandlers: Record<string, (event: MouseEvent) => boolean>;
      },
    ): unknown;
  };
}
interface CmLanguage {
  syntaxTree(state: object): { resolveInner(pos: number, side: number): NodeLike };
  Language: { data(facet: unknown): unknown };
}
interface CmLangMarkdown {
  markdownLanguage: {
    data: { of(ext: { autocomplete: unknown }): unknown };
  };
}

/** `#tag` completion against the live vocabulary, ranked by use then name. */
export function makeTagCompletionSource(getTags: () => readonly TagEntry[]): unknown {
  return (context: {
    matchBefore(re: RegExp): { from: number; to: number; text: string } | null;
    explicit?: boolean;
  }): unknown => {
    // `/` is allowed so a nested tag (`#project/frontend`) completes segment
    // by segment; the canonical grammar is `TAG_NAME_SOURCE` in shared/tags.
    const token = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (!token || (token.from === token.to && !context.explicit)) {
      return null;
    }

    const query = token.text.slice(1).toLowerCase();
    const matches = getTags().filter((entry) => entry.tag.startsWith(query));
    if (matches.length === 0) {
      return null;
    }

    const options = [...matches]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .map((entry) => ({
        label: `#${entry.tag}`,
        apply: `#${entry.tag} `,
        detail: `${entry.count}×`,
      }));

    return { from: token.from, options, validFor: /^#[\p{L}\p{N}_/-]*$/u };
  };
}

/** A leading YAML frontmatter block's length (ported from markdown-frontmatter.ts). */
const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(\n|$)/;
function frontmatterEnd(text: string): number {
  const match = FRONTMATTER.exec(text);
  return match ? match[0].length : 0;
}

/**
 * The `data-tag` pill decorations over the visible ranges (ported from
 * tag-pill.ts). `insideCode` is the syntax-tree check the caller wires to
 * `cm.language.syntaxTree`.
 */
export function tagPillDecorations(
  decoration: DecorationStatic,
  insideCode: (state: EditorStateLike, pos: number) => boolean,
  state: EditorStateLike,
  ranges: readonly { from: number; to: number }[],
): unknown {
  const pillCache = new Map<string, DecorationSet>();
  const pill = (tag: string): DecorationSet => {
    let deco = pillCache.get(tag);
    if (!deco) {
      deco = decoration.mark({ class: 'cm-tag-pill', attributes: { 'data-tag': tag } });
      pillCache.set(tag, deco);
    }
    return deco;
  };

  const deco: DecorationSet[] = [];
  const fmEnd = frontmatterEnd(state.sliceDoc());
  for (const range of ranges) {
    // Widen to whole lines: the shared regex keys off start-of-line /
    // whitespace before the `#`, which a mid-line slice boundary would hide.
    const from = state.doc.lineAt(range.from).from;
    const to = state.doc.lineAt(range.to).to;
    const text = state.sliceDoc(from, to);

    for (const occ of extractTagOccurrences(text)) {
      const start = from + occ.index;
      const end = start + 1 + occ.tag.length;
      if (start < fmEnd || end > state.doc.length || insideCode(state, start)) {
        continue;
      }
      deco.push(pill(occ.tag).range(start, end) as DecorationSet);
    }
  }
  return decoration.set(deco, true);
}

/** True when the surface edits a non-Markdown file (no `#tag` chrome there). */
function isCodeFile(context: EditorSurfaceContext): boolean {
  return (
    context.slot === 'document' &&
    context.filename() !== null &&
    !/\.(md|markdown|mdx)$/i.test(context.filename() ?? '')
  );
}

/**
 * Builds the pills + `#tag` completion extensions for one surface. Returns
 * `[]` for non-Markdown files (a `.cpp` must not grow `#include` pills).
 */
export function tagsExtension(
  cm: CodeMirrorModules,
  getTags: () => readonly TagEntry[],
  onActivate: (tag: string) => void,
  context: EditorSurfaceContext,
): unknown {
  if (isCodeFile(context)) {
    return [];
  }

  const view = cm.view as unknown as CmView;
  const language = cm.language as unknown as {
    syntaxTree(state: object): { resolveInner(pos: number, side: number): NodeLike };
  };
  const markdownData = (cm.langMarkdown as unknown as CmLangMarkdown).markdownLanguage;

  // The completion source rides the host's `markdownLanguage` facet — the
  // SAME instance the Markdown surfaces compile their bundles from.
  const completion = markdownData.data.of({
    autocomplete: makeTagCompletionSource(getTags),
  });

  const insideCode = (state: EditorStateLike, pos: number): boolean => {
    let node: NodeLike | null = language.syntaxTree(state).resolveInner(pos, 1);
    for (; node !== null; node = node.parent) {
      if (/Code|Comment/.test(node.name)) {
        return true;
      }
    }
    return false;
  };

  const pillPlugin = view.ViewPlugin.fromClass(
    class {
      decorations: unknown;
      constructor(editorView: {
        state: EditorStateLike;
        visibleRanges: readonly { from: number; to: number }[];
      }) {
        this.decorations = tagPillDecorations(
          view.Decoration,
          insideCode,
          editorView.state,
          editorView.visibleRanges,
        );
      }
      update(update: {
        docChanged: boolean;
        viewportChanged: boolean;
        state: EditorStateLike;
        view: { visibleRanges: readonly { from: number; to: number }[] };
      }): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = tagPillDecorations(
            view.Decoration,
            insideCode,
            update.state,
            update.view.visibleRanges,
          );
        }
      }
    },
    {
      decorations: (v: { decorations: unknown }) => v.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent): boolean {
          if (!event.ctrlKey && !event.metaKey) {
            return false;
          }
          const target = event.target as HTMLElement | null;
          const tag = target?.closest('.cm-tag-pill')?.getAttribute('data-tag');
          if (!tag) {
            return false;
          }
          event.preventDefault();
          onActivate(tag);
          return true;
        },
      },
    },
  );

  const theme = view.EditorView.theme({
    '.cm-tag-pill': {
      color: 'var(--accent)',
      backgroundColor: 'rgba(201, 100, 66, 0.13)',
      borderRadius: '4px',
      padding: '0 3px',
      cursor: 'pointer',
    },
    '.cm-tag-pill:hover': {
      backgroundColor: 'rgba(201, 100, 66, 0.22)',
    },
  });

  return [pillPlugin, theme, completion];
}
