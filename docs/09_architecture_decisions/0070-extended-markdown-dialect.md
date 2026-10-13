# 0070 — The extended Markdown dialect (GFM+, callouts, math, footnotes)

## Status

Accepted (milestone 72). Extends ADR-0009 (Live Preview) — the conceal
and block-widget layers gained constructs; the editing model is
unchanged.

**Later change (same milestone):** the dialect gained its *insert*
affordances — the new constructs became reachable, not just readable.
One pure reducer layer (`src/app/editor/toolbar-commands.ts`) serves
three entries: the formatting toolbar (highlight button; sub/sup,
callout and math menus; footnote and emoji buttons), the `/` menu
(Highlight … Footnote plus `/emoji`), and the editor's right-click menu
(`editor-context-menu/format-menu-rows.ts`, base rows on every Markdown
CodeMirror surface — pane docs, the entry drawer, the composers). The
`:emoji:` shortcode is inserted through ONE place, the picker service
(`src/app/emoji-picker/`): an App-level search + grid overlay over the
curated table (recents persisted under `drey.emoji.recent`), opened
from the toolbar, the context menu and `/emoji`; typing `:jo` in prose
additionally completes shortcodes (`src/app/editor/emoji/`, the typing
twin, silent behind word characters so times, URLs and prose colons
never fire). Footnote inserts are a single undo step across both spans
(ref at the selection, definition appended); a selection ending past a
line break backs onto the paragraph, so triple-click flows read right.
The **formatting eraser** completes the set: `Mod+\` (or the toolbar's
eraser button, `/clear`, the context-menu row) peels the OUTERMOST
inline wrap at the caret -- markers gone, content kept, links reduced
to their label -- or, with a selection, wipes every wrap the selection
overlaps (`src/app/editor/erase-formatting.ts`, a syntax-tree walk --
"outermost" is not a string-reducer concept).

**Later change (req-41):** the three entries are still one reducer
layer, but the right-click menu no longer lists the commands as text
rows. It carries the **formatting strip** instead -- the toolbar's own
component (`markdown-toolbar.ts`, regrouped into ten buttons with
paragraph-style, text-format, list, table and Insert menus) as the
menu's head -- the clipboard list is its first menu, one menu open at
a time -- acting on the right-clicked view through
`src/app/editor/toolbar-dispatch.ts`
(`editor-context-menu/format-strip-target.ts` decides where it shows;
`format-menu-rows.ts` is gone). The highlight, sub/sup, callout, math,
footnote and emoji buttons named above are rows of those menus now,
and the eraser is the text-format menu's *Clear formatting* row. A
pin docks the strip into the meta bar or releases it.

## Context

The editor's Markdown was CommonMark + GFM tables/strikethrough/task
lists/autolinks, plus Pandoc sub/superscript in the grammar but never
rendered. Everything beyond that stayed raw text: `==highlight==`,
`$…$` / `$$…$$` math, `[^footnote]`, GitHub-alert/Obsidian callouts,
`:emoji:` shortcodes — all things a vault written elsewhere (GitHub,
Obsidian, pandoc) brings along, and all listed on the markdownguide
basic/extended pages the owner named as the reference. The roadmap
carried "Math (KaTeX) and callouts in Live Preview" and req-13
(footnotes) as backlog items; the built-in Lezer `Emoji` parser had been
removed because ANY `name:` matched, so timestamps like `00:03:48` lit
up as `:03:`.

Every Markdown view shares one surface (`MarkdownSurface`: full-page
editor, entry drawer, composer, help manual, view mode, scratch tabs),
so "all md views" is one implementation site — but the markdown-it
renders (table cells, HTML regions) and the PDF export are second and
third engines that must agree (the milestone-32 parity standing rule).

## Decision

- **One dialect across three engines.** The shapes parse identically in
  the Lezer grammar (`src/app/editor/markdown-extensions.ts`) and the
  markdown-it rules (`shared/markdown/markdown-it-extended.ts`): `==x==`
  highlight, `~x~` / `^x^` sub/superscript (rendered, not just parsed),
  `$x$` / `$$x$$` math with the currency guard (opening `$` never
  before whitespace, closing `$` never after), `[^label]` references +
  definitions numbered in document order, GitHub's five callout kinds
  with Obsidian's aliases folded onto them, bare-URL autolinking
  (`linkify`) with code spans as the documented way to disable it, and
  curated `:shortcode:` emoji — only names in the generated gemoji table
  (`shared/markdown/emoji-table.ts`) ever match, which is what keeps
  `00:03:48` plain text.
- **KaTeX, lazily, twice.** The editor typesets through `MathWidget`
  (`renderToString`, `trust: false`), the script loading on the first
  formula like mermaid; the stylesheet and its woff2 fonts ship as
  static assets and are `<link>`-injected at that moment (in the initial
  CSS they cost ~300 KB of bundle budget for notes without math). The
  PDF export inlines the script plus the stylesheet with every font as a
  `data:` URL into the one self-contained print page, and a synchronous
  bootstrap (`KATEX_BOOTSTRAP`) typesets the `.drey-math` placeholders —
  no settle wait, unlike mermaid. A parse error shows the compact red
  box (click = back into the source) in the editor, and keeps the LaTeX
  visible in the PDF. Math inside editor table cells renders as a styled
  source span — the cell render is synchronous and no KaTeX copy rides
  it.
- **Callouts render statically.** GitHub-alert behaviour, not Obsidian's
  folding: the quote's lines take the tinted container classes, the
  `[!TYPE]` marker is replaced by icon (+ label when no custom title
  follows; a custom title stays as the text after the marker), and the
  Obsidian `-`/`+` fold suffix is parsed and normalized away.
- **Engine-appropriate placement.** Inline constructs are Lezer inline
  parsers (code spans and escapes win by construction); `$$` blocks are
  a leaf-block parser that interrupts paragraphs like a fence but
  ABSORBS its closer (returning `true` from `nextLine` re-parses the
  closer line as a new block — the phantom-`$$` trap); callouts need no
  grammar at all (the blockquote's first line is scanned textually);
  footnote references run `before: 'Link'` so `[` cannot start a link
  delimiter, definitions `before: 'LinkReference'` so `[^x]: …` never
  reads as a reference definition.

## Consequences

- The dialect is a superset of GFM: GitHub/Obsidian/pandoc notes render
  as their authors expect, and the same names parse in the editor, in
  table cells and in the PDF (unit suites pin the overlap; e2e pins the
  editor surfaces).
- Two new runtime dependencies: `katex` (same version family mermaid
  already pulls in) and `markdown-it-footnote`; `gemoji` is a
  devDependency behind `npm run emoji:table`, which regenerates the
  checked-in table.
- The emoji lookup costs ~30 KB in the initial bundle (the curated
  table) — the price of timestamps staying plain text.
- Spellcheck masks math, footnote refs, callout markers and shortcodes
  (`shared/spellcheck.ts`) so LaTeX is not flagged as prose.
- The assistant panel's deliberately small chat-card subset
  (`rich-text.ts`) is unchanged — model output is untrusted text, and
  callout/math rendering there gained nothing until asked for.
- Not carried: Obsidian's foldable callouts (static boxes by decision),
  definition lists (GitHub does not render them), and footnote
  references are not click-to-jump (the number is informational; the
  definitions sit at the document's foot).
