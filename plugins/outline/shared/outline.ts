/**
 * Pure outline scanning + tree building for the Outline panel. The panel
 * is renderer-only, so this module serves the renderer and its unit
 * tests; it lives in `shared/` like every plugin's pure logic.
 *
 * Scanner conventions (identical to the tags/tasks section scanners, so
 * the outline agrees with search, tasks and the wikilink anchors):
 *
 *  - **ATX headings only** (`#` .. `######`); setext underlines
 *    (`===` / `---`) are not headings. Up to six `#`, at least one space
 *    after them, closing `#`s stripped.
 *  - **Fence-aware**: ``` / ~~~ blocks are skipped, so a `#` line written
 *    inside a code example never becomes an outline entry. The toggle is
 *    deliberately naive (any fence line flips state, opener/closer kinds
 *    are not matched) — exactly what the tags/tasks scanners do.
 *  - **Frontmatter skipped**: a leading `---` ... `---` (or `...`) block
 *    is YAML, where a `# comment` line is not a heading.
 */

export interface OutlineEntry {
  /** 1..6, from the `#` run. */
  readonly level: number;
  /** Heading text without the markers and closing `#`s. */
  readonly title: string;
  /** 1-based line the heading sits on. */
  readonly line: number;
}

/** One node of the outline tree: an entry plus its nested subsections. */
export interface OutlineNode {
  readonly entry: OutlineEntry;
  /**
   * Stable identity across re-scans: the ancestor title chain plus an
   * occurrence index. Line numbers shift while editing; title chains do
   * not, so expand/collapse state survives every re-render.
   */
  readonly key: string;
  readonly children: OutlineNode[];
}

const FENCE = /^[ \t]*(```|~~~)/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(---|\.\.\.)[ \t]*$/;

/** Every heading in `content`, in document order. */
export function scanOutline(content: string): OutlineEntry[] {
  const lines = content.split('\n');
  const out: OutlineEntry[] = [];
  let inFence = false;
  let start = 0;

  // A leading frontmatter block is metadata, not body: its `#` lines are
  // YAML comments. Unclosed block = the whole file is frontmatter.
  if (lines.length > 0 && FRONTMATTER_OPEN.test(lines[0])) {
    start = lines.length;
    for (let i = 1; i < lines.length; i++) {
      if (FRONTMATTER_CLOSE.test(lines[i])) {
        start = i + 1;
        break;
      }
    }
  }

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const h = HEADING.exec(raw);
    if (h) {
      out.push({ level: h[1].length, title: h[2], line: i + 1 });
    }
  }
  return out;
}

/** Builds the heading tree: a node's children are the following deeper headings. */
export function buildOutlineTree(entries: readonly OutlineEntry[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const occurrences = new Map<string, number>();

  for (const entry of entries) {
    while (stack.length > 0 && stack[stack.length - 1].entry.level >= entry.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const chain = parent === undefined ? entry.title : `${parent.key}\u0000${entry.title}`;
    const nth = occurrences.get(chain) ?? 0;
    occurrences.set(chain, nth + 1);
    const node: OutlineNode = {
      entry,
      key: `${chain}\u0000${nth}`,
      children: [],
    };
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/** Every node of `nodes` that has children, depth-first (for collapse-all). */
export function parentKeys(nodes: readonly OutlineNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly OutlineNode[]): void => {
    for (const node of list) {
      if (node.children.length > 0) {
        out.push(node.key);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
