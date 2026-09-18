/**
 * Markdown -> self-contained HTML for the "Export as PDF…" feature. Pure
 * string in, pure string out -- no filesystem, no Electron, no DOM -- so
 * main (`electron/pdf-export.ts`) renders with it and the renderer test
 * suite can pin its behavior, the same split as `shared/frontmatter.ts`.
 *
 * The output is a full document with an embedded light "paper" stylesheet:
 * white pages, print-friendly, typography borrowed from the app's token
 * stacks (`src/styles.css`) -- sans body, serif headings, mono code. The
 * PDF is meant to leave the vault, so it deliberately does NOT follow the
 * dark app theme.
 *
 * Mermaid fences render as diagrams when the caller passes the mermaid
 * runtime script (`mermaidRuntime`, read main-side from the packaged
 * dependency): it is inlined into the page together with a bootstrap that
 * swaps each rendered SVG in for its code block. Without the runtime -- or
 * on a parse error / per-diagram timeout -- the fence stays a code block.
 * `[[wikilinks]]` stay literal text by decision (they name in-vault
 * targets a PDF reader can't follow).
 */
import MarkdownIt from 'markdown-it';
import { imageExtension, pdfExtension } from './asset-name';
import { splitFrontmatter } from './frontmatter';

export interface PdfHtmlOptions {
  /** The full note text; a frontmatter fence is stripped here. */
  markdown: string;
  /** `<title>` / `<h1>` fallback when the body starts with no heading. */
  title?: string;
  /**
   * Rewrites an image reference to a loadable URL. `null` drops the image
   * (its alt text stays). Called for Markdown images AND raw-HTML `<img>`
   * tags from `html: true` blocks; absent, `http(s)`/`data` URLs pass
   * through and relative ones are dropped.
   */
  resolveImageSrc?: (rawUrl: string) => string | null;
  /**
   * The mermaid UMD bundle (`mermaid/dist/mermaid.min.js`, exposes
   * `globalThis.mermaid`), inlined verbatim so the print window can render
   * ` ```mermaid ` fences. Embedded only when the note actually has a
   * mermaid fence; absent → the fences stay code blocks.
   */
  mermaidRuntime?: { script: string };
}

/** Task-list glyphs (GFM checkboxes don't exist in print CSS). */
const TASK_OPEN = '☐';
const TASK_DONE = '☑';

/** `- [ ] ` / `1. [x] ` style task items -> the glyph, outside code fences. */
const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/;

/**
 * Rewrites task-list markers to glyphs, line by line, tracking fenced code
 * blocks (``` / ~~~) so their contents stay verbatim.
 */
export function replaceTaskMarkers(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trim().match(/^(`{3,}|~{3,})/);
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
    const task = lines[i].match(TASK_ITEM);
    if (task) {
      lines[i] = task[1] + (task[2] === ' ' ? TASK_OPEN : TASK_DONE) + ' ' + lines[i].slice(task[0].length);
    }
  }
  return lines.join('\n');
}

/**
 * Strips `<script>` blocks and inline `on*="…"` handler attributes from
 * raw HTML -- defense in depth for `html: true` note HTML alongside the
 * sandboxed print window, not a sanitizer claim. The `on*` pass anchors
 * inside a tag (`<tag … on…=`), so plain text like "one = 2" survives.
 */
export function stripActiveHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/(<[a-z][^>]*?)\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
}

/**
 * Rewrites Obsidian-style media embeds (milestone 31; ADR-0046 addendum):
 * `![[name.png]]` / `![[name.pdf]]` — image or PDF extension, an optional
 * `|alias` suffix dropped — become standard Markdown images, so the
 * markdown-it pass renders them and the shared image-resolution chain
 * (with its `attachments/` fallback) applies. `[[note]]` links and media
 * embeds with a `#anchor` stay literal text (they name in-vault targets a
 * PDF reader can't follow). Fenced code is left alone, same fence
 * tracking as `replaceTaskMarkers`.
 */
export function rewriteEmbedWikilinks(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trim().match(/^(`{3,}|~{3,})/);
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
    lines[i] = lines[i].replace(/!\[\[([^\[\]\n]+?)\]\]/g, (whole: string, target: string) => {
      const name = target.split('|')[0].split('#')[0].trim();
      if (imageExtension(name) === null && pdfExtension(name) === null) {
        return whole;
      }
      // Angle brackets: asset names like `Pasted image 20260427105518.png`
      // contain spaces, which end an ordinary CommonMark destination.
      return `![](<${name}>)`;
    });
  }
  return lines.join('\n');
}

/**
 * Whether the note contains a ` ```mermaid ` fenced block (fence tracking
 * like {@link replaceTaskMarkers}; the info string's first token decides,
 * the same predicate the Live Preview widget uses via `fenceLang`). Main
 * uses this to skip reading the ~3.5 MB mermaid runtime for notes that
 * have no diagram.
 */
export function hasMermaidFence(markdown: string): boolean {
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fence = line.trim().match(/^(`{3,}|~{3,})\s*(.*)$/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
        const info = fence[2].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (info === 'mermaid') {
          return true;
        }
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
  }
  return false;
}

/**
 * Makes a script safe to inline into a `<script>` element: a literal
 * `</script` anywhere in the text (string literal, regex, …) would close
 * the element early. `<\/script` is the same character sequence once the
 * JS engine reads it (`\/` === `/` in strings and templates, an escaped
 * slash in regexes), and outside those it cannot occur in valid JS.
 */
function escapeInlineScript(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script');
}

/**
 * Runs after the mermaid bundle has loaded: initialises mermaid for the
 * light paper page (the editor's dark config is deliberately not reused --
 * the PDF leaves the vault), renders every ` ```mermaid ` code block and
 * replaces it with a `<figure class="mermaid-figure">`. A parse/render
 * error or the 20 s per-diagram cap leaves that block untouched, and the
 * `__dreyMermaidSettled` promise tells main when every diagram has
 * settled. Plain ES5 style -- it is inlined into the generated page.
 *
 * Exposed for the renderer unit suite, which executes it against a stub
 * `mermaid` in a real iframe (the same suite runs in Chrome).
 */
export const MERMAID_BOOTSTRAP = `
(function () {
  'use strict';
  var blocks = Array.prototype.slice.call(
    document.querySelectorAll('pre > code.language-mermaid'));
  if (blocks.length === 0 || typeof window.mermaid === 'undefined') {
    return;
  }
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
    darkMode: false,
    suppressErrorRendering: true,
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', 'Helvetica Neue', sans-serif"
  });
  var seq = 0;
  function withCap(promise, cap) {
    return Promise.race([promise, new Promise(function (resolve) {
      setTimeout(resolve, cap);
    })]);
  }
  window.__dreyMermaidSettled = Promise.all(blocks.map(function (code) {
    var id = 'drey-pdf-' + (seq += 1);
    var pre = code.parentElement;
    var done = window.mermaid.render(id, code.textContent)
      .then(function (result) {
        var fig = document.createElement('figure');
        fig.className = 'mermaid-figure';
        fig.innerHTML = result.svg;
        if (pre !== null && pre.parentElement !== null) {
          pre.parentElement.replaceChild(fig, pre);
        }
      })
      .catch(function () {
        /* Parse or layout failure: the code block stays. */
      })
      .then(function () {
        var leftover = document.getElementById('d' + id);
        if (leftover !== null) {
          leftover.remove();
        }
      });
    return withCap(done, 20000);
  }));
})();
`.trim();

/**
 * Renders the note to a complete HTML document. `[[wikilinks]]` pass
 * through as literal text (markdown-it leaves unknown syntax alone;
 * media embeds are rewritten to images first, see
 * {@link rewriteEmbedWikilinks}). Mermaid fences stay code blocks in the
 * markup -- when {@link PdfHtmlOptions.mermaidRuntime} is given they are
 * rendered in the page by the inlined runtime before the print.
 */
export function buildNotePdfHtml(options: PdfHtmlOptions): string {
  const { markdown, title, resolveImageSrc, mermaidRuntime } = options;
  const body = rewriteEmbedWikilinks(splitFrontmatter(markdown).body);
  const md = new MarkdownIt({ html: true, typographer: true });

  if (resolveImageSrc) {
    // Markdown-source images: run the raw url through the callback; a null
    // drops the <img> but keeps the alt text. Mirrors markdown-it's own
    // default rule (alt from the rendered children, then renderToken).
    md.renderer.rules['image'] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const src = resolveImageSrc(String(token.attrGet('src') ?? ''));
      if (src === null) {
        return md.utils.escapeHtml(token.content);
      }
      token.attrSet('src', src);
      token.attrSet('alt', self.renderInlineAsText(token.children ?? [], options, env));
      return self.renderToken(tokens, idx, options);
    };
  }

  let html = stripActiveHtml(md.render(replaceTaskMarkers(body)));

  if (resolveImageSrc) {
    // Raw-HTML `<img>` tags (html: true lets them through verbatim). Srcs
    // that are already final (https/data from the note, file:// from the
    // markdown rule above) are left alone -- only relative references go
    // through the callback here.
    html = html.replace(/<img\b[^>]*>/gi, (tag: string) => {
      const src = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (src === null) {
        return '';
      }
      const raw = src[2] ?? src[3] ?? '';
      if (/^(https?:|data:|file:)/i.test(raw.trim())) {
        return tag;
      }
      const resolved = resolveImageSrc(raw);
      return resolved === null ? '' : tag.replace(src[0], ` src="${resolved}"`);
    });
  }

  const safeTitle = (title ?? '').trim();
  const headingHtml =
    safeTitle && !/^<h[1-6]\b/m.test(html.trim()) ? `<h1>${md.utils.escapeHtml(safeTitle)}</h1>\n` : '';
  // Appended AFTER stripActiveHtml: the note's own markup never yields a
  // script tag; these two are ours (bundle + bootstrap).
  const mermaidScripts =
    mermaidRuntime !== undefined && hasMermaidFence(body)
      ? `\n<script>${escapeInlineScript(mermaidRuntime.script)}</script>\n<script>${MERMAID_BOOTSTRAP}</script>\n`
      : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${md.utils.escapeHtml(safeTitle || 'Export')}</title>
<style>
${PAPER_CSS}
</style>
</head>
<body>
${headingHtml}${html}${mermaidScripts}
</body>
</html>
`;
}

/**
 * Light paper stylesheet. Font stacks mirror `src/styles.css` tokens
 * (`--font-sans` / `--font-serif` / `--font-mono`) so the PDF reads as the
 * app's typography; Newsreader/IBM Plex Mono simply fall back like they do
 * in the app when the platform lacks them. Code/table fills rely on
 * `printToPDF({ printBackground: true })`.
 */
const PAPER_CSS = `
  /* No @page rule on purpose: CSS @page margins would override the
     printToPDF margins, and margin: 0 here is exactly the "bleeds to the
     page edge" bug. Page geometry comes from printToPDF alone. */
  html {
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  body {
    margin: 0;
    color: #1f2328;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif;
    font-size: 11pt;
    line-height: 1.6;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: 'Newsreader', Georgia, 'Times New Roman', serif;
    line-height: 1.3;
    color: #111418;
    break-after: avoid;
  }
  h1 { font-size: 22pt; margin: 0 0 0.6em; }
  h2 { font-size: 16pt; margin: 1.4em 0 0.5em; border-bottom: 1px solid #e4e6e8; padding-bottom: 0.2em; }
  h3 { font-size: 13pt; margin: 1.2em 0 0.4em; }
  h4, h5, h6 { font-size: 11.5pt; margin: 1em 0 0.3em; }
  p { margin: 0.5em 0; }
  a { color: #c96442; text-decoration: none; }
  code, pre, kbd {
    font-family: 'IBM Plex Mono', ui-monospace, 'Cascadia Code', 'Consolas', monospace;
    font-size: 9.5pt;
  }
  code { background: #f2f4f6; border-radius: 3px; padding: 0.1em 0.35em; }
  pre {
    background: #f6f8fa;
    border: 1px solid #e4e6e8;
    border-radius: 6px;
    padding: 0.7em 0.9em;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 0.8em 0; break-inside: avoid; }
  th, td { border: 1px solid #d7dadd; padding: 0.35em 0.7em; text-align: left; }
  th { background: #f2f4f6; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.1em 1em;
    border-left: 3px solid #d7dadd;
    color: #57606a;
  }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e4e6e8; margin: 1.5em 0; }
  .mermaid-figure {
    margin: 1em 0;
    break-inside: avoid;
  }
  .mermaid-figure svg {
    max-width: 100%;
    height: auto;
  }
`;
