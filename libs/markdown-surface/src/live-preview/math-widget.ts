/**
 * KaTeX widgets for Live Preview math (milestone: extended Markdown).
 * `$…$` renders as an inline replace widget, `$$…$$` blocks as a block
 * widget with the `</>` view-source button — the same widget/reveal dance
 * as images and mermaid diagrams (ADR-0009): the selection touching the
 * source flips back to the raw `$…$` text.
 *
 * KaTeX is loaded lazily on the first formula (it is a few hundred KB,
 * like mermaid). `renderToString` runs with `trust` off, so its output
 * HTML carries no scripts or external URLs; a parse error renders the
 * compact red box (click anywhere on it to get back into the source,
 * same as a broken diagram).
 */
import { WidgetType } from '@codemirror/view';
import { appendTools, ignoreWidgetEvent, makeEditButton } from './widget-chrome';

let katexPromise: Promise<typeof import('katex').default> | null = null;
let stylesheetInjected = false;

/**
 * Drops the bundled KaTeX stylesheet into the document once. The CSS and
 * its woff2 fonts ship as static assets (`angular.json`) and load only
 * when a formula first renders — inlined into the app's initial CSS they
 * cost ~300 KB of budget for every note without math.
 */
function ensureStylesheet(): void {
  if (stylesheetInjected || document.getElementById('drey-katex-css') !== null) {
    return;
  }
  const link = document.createElement('link');
  link.id = 'drey-katex-css';
  link.rel = 'stylesheet';
  link.href = 'katex/katex.min.css';
  document.head.appendChild(link);
  stylesheetInjected = true;
}

function loadKatex(): Promise<typeof import('katex').default> {
  if (!katexPromise) {
    ensureStylesheet();
    katexPromise = import('katex').then((mod) => mod.default);
  }
  return katexPromise;
}

/**
 * Renders `latex` to KaTeX HTML. Pure string in/string out (plus the
 * load), so the unit suite can pin it without a CodeMirror view.
 */
export async function renderMathToHtml(latex: string, display: boolean): Promise<string> {
  const katex = await loadKatex();
  return katex.renderToString(latex, {
    displayMode: display,
    throwOnError: true,
    strict: false,
    trust: false,
  });
}

export class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.latex === this.latex && other.display === this.display;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement(this.display ? 'div' : 'span');
    wrap.className = this.display ? 'lp-math-block' : 'lp-math-inline';
    const pending = document.createElement('span');
    pending.className = 'lp-math-pending';
    pending.textContent = '…';
    wrap.appendChild(pending);
    if (this.display) {
      appendTools(wrap).appendChild(makeEditButton());
    }
    void this.render(wrap);
    return wrap;
  }

  private async render(wrap: HTMLElement): Promise<void> {
    let result: HTMLElement;
    try {
      const html = await renderMathToHtml(this.latex, this.display);
      result = document.createElement(this.display ? 'div' : 'span');
      result.className = this.display ? 'lp-math-display' : 'lp-math-typeset';
      result.innerHTML = html;
    } catch (error) {
      result = document.createElement('span');
      result.className = 'lp-math-error';
      result.textContent = `Math: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!wrap.isConnected) {
      return; // the widget was replaced while KaTeX worked
    }
    wrap.querySelector('.lp-math-pending')?.remove();
    if (this.display) {
      wrap.insertBefore(result, wrap.querySelector('.lp-tools'));
    } else {
      wrap.appendChild(result);
    }
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreWidgetEvent(event);
  }
}
