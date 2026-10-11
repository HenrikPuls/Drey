/**
 * Math syntax detection shared by the render pipelines. The Lezer grammar
 * (`src/app/editor/markdown-extensions.ts`) and the markdown-it rules
 * (`shared/markdown/markdown-it-extended.ts`) each parse precisely; this
 * scanner only answers "is there math at all" so callers can decide
 * whether to load KaTeX (the editor's lazy import, main's PDF runtime).
 *
 * Fence-aware the same way `shared/pdf-html.ts` tracks fences for mermaid:
 * a `$` inside a code block is money, not math.
 */
export function hasMathSyntax(markdown: string): boolean {
  let inFence = false;
  let fenceMarker = '';
  for (const line of markdown.split('\n')) {
    const fence = line.trim().match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    // Unescaped `$` that opens a span (`$$` or `$` before a non-space).
    if (/(^|[^\\])\$(?:\$|[^$\s])/.test(line)) {
      return true;
    }
  }
  return false;
}
