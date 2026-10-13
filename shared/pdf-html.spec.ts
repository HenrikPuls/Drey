/// <reference lib="dom" />
// @vitest-environment jsdom
import {
  buildNotePdfHtml,
  hasMermaidFence,
  KATEX_BOOTSTRAP,
  MERMAID_BOOTSTRAP,
  replaceTaskMarkers,
  rewriteEmbedWikilinks,
  stripActiveHtml,
} from './pdf-html';

/** The one document the assertions below dig into. */
function render(markdown: string, title?: string, resolve?: (url: string) => string | null): string {
  return buildNotePdfHtml({ markdown, title, resolveImageSrc: resolve });
}

describe('replaceTaskMarkers', () => {
  it('rewrites GFM checkboxes to glyphs in bullet and ordered lists', () => {
    expect(replaceTaskMarkers('- [ ] open\n- [x] done\n* [X] also done\n1. [ ] numbered')).toBe(
      '- ☐ open\n- ☑ done\n* ☑ also done\n1. ☐ numbered',
    );
  });

  it('leaves fenced code and non-task lines alone', () => {
    const fenced = 'text\n```\n- [ ] verbatim\n```\n~~~\n- [x] verbatim too\n~~~\n- [ ] after';
    expect(replaceTaskMarkers(fenced)).toBe('text\n```\n- [ ] verbatim\n```\n~~~\n- [x] verbatim too\n~~~\n- ☐ after');
  });
});

describe('stripActiveHtml', () => {
  it('removes script blocks and inline event handlers', () => {
    const dirty = '<p onclick="steal()">hi</p><script>alert(1)</script><img onerror="x()" src="a.png">';
    const clean = stripActiveHtml(dirty);
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onerror');
    expect(clean).toContain('<p>hi</p>');
    expect(clean).toContain('src="a.png"');
  });

  it('leaves plain text like "one = 2" alone', () => {
    expect(stripActiveHtml('<p>one = 2 and once = more</p>')).toBe('<p>one = 2 and once = more</p>');
  });
});

describe('buildNotePdfHtml', () => {
  it('strips the frontmatter fence and renders the body', () => {
    const html = render('---\ntype: notiz\n---\n\n# Titel\n\ntext', 'Name');
    expect(html).not.toContain('type: notiz');
    expect(html).toContain('<h1>Titel</h1>');
    expect(html).toContain('<p>text</p>');
  });

  it('emits the title as h1 when the body has no heading of its own', () => {
    const html = render('just text', 'My Note');
    expect(html).toContain('<h1>My Note</h1>');
  });

  it('keeps an existing body heading and the title only in <title>', () => {
    const html = render('# Already Titled\n\nbody', 'My Note');
    expect(html).toContain('<title>My Note</title>');
    expect(html).toContain('<h1>Already Titled</h1>');
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });

  it('renders tables, fenced code and blockquotes', () => {
    const html = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n> quoted');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code');
    expect(html).toContain('<blockquote>');
  });

  it('keeps wikilinks as literal text', () => {
    const html = render('see [[Zielnote]] here');
    expect(html).toContain('[[Zielnote]]');
    expect(html).not.toContain('<a');
  });

  it('strips scripts and event handlers from raw note HTML', () => {
    const html = render('<p onclick="x()">hi</p><script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('<p>hi</p>');
  });

  it('applies the image callback to markdown images', () => {
    const html = render('![Alt text](pics/x.png)', undefined, (u) => (u === 'pics/x.png' ? 'file:///r/x.png' : null));
    expect(html).toContain('<img src="file:///r/x.png" alt="Alt text">');
  });

  it('applies the callback to raw-HTML img tags and drops null results', () => {
    const html = render('<img src="pics/y.png" alt="y">', undefined, (u) => (u === 'pics/y.png' ? 'file:///r/y.png' : null));
    expect(html).toContain('src="file:///r/y.png"');

    const dropped = render('![gone](missing.png)', undefined, () => null);
    expect(dropped).not.toContain('<img');
    expect(dropped).toContain('gone');
  });

  it('passes http(s) and data urls through the callback untouched', () => {
    const pass = (u: string): string | null => (/^(https?:|data:)/.test(u) ? u : null);
    const html = render('![r](https://example.com/i.png)\n\n![d](data:image/png;base64,AAA)', undefined, pass);
    expect(html).toContain('src="https://example.com/i.png"');
    expect(html).toContain('src="data:image/png;base64,AAA"');
  });

  it('escapes html-dangerous title text', () => {
    const html = render('body', '<script>x</script>');
    expect(html).toContain('<title>&lt;script&gt;x&lt;/script&gt;</title>');
  });

  it('embeds the paper stylesheet as a light page', () => {
    const html = render('# t');
    expect(html).toContain('print-color-adjust: exact');
    expect(html).toContain("font-family: 'Newsreader', Georgia");
  });
});

describe('PDF embed fallback (docs/06 §6.39)', () => {
  const resolver = (u: string): string | null => (u === 'pics/x.png' ? 'file:///r/x.png' : null);

  it('prints a visible note for a ![[x.pdf]] embed instead of an empty <img>', () => {
    const html = render('![[Quarterly Report.pdf]]', undefined, resolver);
    expect(html).toContain('PDF embed — not printable: <code>Quarterly Report.pdf</code>');
    expect(html).not.toContain('<img');
  });

  it('covers a hand-written Markdown pdf image too', () => {
    const html = render('![](attachments/x.pdf)', undefined, resolver);
    expect(html).toContain('PDF embed — not printable');
    expect(html).not.toContain('<img');
  });

  it('decodes a percent-encoded pdf name', () => {
    const html = render('![](my%20report.pdf)', undefined, resolver);
    expect(html).toContain('my report.pdf');
  });

  it('leaves image embeds and images alone', () => {
    const html = render('![[pics/x.png]]\n\n![Alt](pics/x.png)', undefined, resolver);
    expect(html).toContain('<img src="file:///r/x.png"');
    expect(html).not.toContain('PDF embed — not printable');
  });

  it('replaces a raw-HTML pdf img tag with the note', () => {
    const html = render('<img src="x.pdf" alt="x">', undefined, resolver);
    expect(html).toContain('PDF embed — not printable');
    expect(html).not.toContain('<img');
  });
});

describe('rewriteEmbedWikilinks (milestone 31)', () => {
  it('rewrites media embeds to angle-bracket Markdown images', () => {
    expect(rewriteEmbedWikilinks('![[Pasted image 20260427105518.png]]')).toBe(
      '![](<Pasted image 20260427105518.png>)',
    );
    expect(rewriteEmbedWikilinks('![[doc.pdf|300]]')).toBe('![](<doc.pdf>)');
  });

  it('leaves note links, anchors, non-media targets and code fences alone', () => {
    expect(rewriteEmbedWikilinks('[[Some note]]')).toBe('[[Some note]]');
    expect(rewriteEmbedWikilinks('![[Note#Heading]]')).toBe('![[Note#Heading]]');
    expect(rewriteEmbedWikilinks('![[archive.zip]]')).toBe('![[archive.zip]]');
    expect(rewriteEmbedWikilinks('```\n![[x.png]]\n```')).toBe('```\n![[x.png]]\n```');
  });

  it('a rewritten embed renders into the html and the resolver sees the bare name', () => {
    const html = buildNotePdfHtml({
      markdown: '---\ntitle: t\n---\n\n![[pic with spaces.png]]\n',
      title: 't',
      // markdown-it hands the destination percent-encoded; the real
      // resolver (shared/asset-refs.ts) offers the decoded reading.
      resolveImageSrc: (url) =>
        decodeURIComponent(url) === 'pic with spaces.png' ? 'file:///resolved.png' : null,
    });
    expect(html).toContain('src="file:///resolved.png"');
  });
});

describe('hasMermaidFence (milestone 32)', () => {
  it('detects backtick and tilde mermaid fences, extra info words included', () => {
    expect(hasMermaidFence('```mermaid\ngraph TD\nA-->B\n```')).toBe(true);
    expect(hasMermaidFence('~~~mermaid\ngraph TD\nA-->B\n~~~')).toBe(true);
    expect(hasMermaidFence('```mermaid extra words\nA-->B\n```')).toBe(true);
    // Unclosed fence: markdown-it renders it to EOF with that language.
    expect(hasMermaidFence('```mermaid\ngraph TD')).toBe(true);
  });

  it('ignores the word inside other fences and other languages', () => {
    expect(hasMermaidFence('```js\nmermaid would be nice\n```')).toBe(false);
    expect(hasMermaidFence('```mermaidx\nA-->B\n```')).toBe(false);
    // The tracker closes at the inner markers, so the info string is never
    // seen -- and markdown-it (closing fences take no info string) also
    // renders no mermaid block here. Same verdict by different paths.
    expect(hasMermaidFence('```\n```mermaid\nA-->B\n```\n```')).toBe(false);
  });
});

describe('buildNotePdfHtml mermaid runtime (milestone 32)', () => {
  const FENCE = '```mermaid\ngraph TD\nA-->B\n```';

  it('embeds nothing without a fence, even when a runtime is given', () => {
    const html = buildNotePdfHtml({ markdown: '# t', mermaidRuntime: { script: 'window.X=1;' } });
    expect(html).not.toContain('<script');
  });

  it('keeps the code block when no runtime is available', () => {
    const html = render(FENCE);
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).not.toContain('<script');
  });

  it('inlines bundle and bootstrap when the note has a mermaid fence', () => {
    const html = buildNotePdfHtml({ markdown: FENCE, mermaidRuntime: { script: 'window.X=1;' } });
    expect(html).toContain('window.X=1;');
    expect(html).toContain('__dreyMermaidSettled');
    // The code block stays in the markup -- it is the fallback the
    // bootstrap replaces (or leaves on a parse error).
    expect(html).toContain('<code class="language-mermaid">');
  });

  it('a </script> sequence inside the runtime cannot close the element early', () => {
    const html = buildNotePdfHtml({
      markdown: FENCE,
      mermaidRuntime: { script: 'var s = "</scr" + "</script><script>alert(1)</script>";' },
    });
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('<\\/script>');
  });

  it('note-authored scripts stay stripped even when the runtime is embedded', () => {
    const html = buildNotePdfHtml({
      markdown: `<script>alert(1)</script>\n\n${FENCE}`,
      mermaidRuntime: { script: 'window.X=1;' },
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('window.X=1;');
  });

  it('the paper stylesheet carries the figure rules', () => {
    expect(render('# t')).toContain('.mermaid-figure');
    expect(render('# t')).toContain('break-inside: avoid');
  });
});

describe('buildNotePdfHtml extended markdown (milestone 71)', () => {
  it('renders highlight, subscript and superscript', () => {
    const html = render('a ==marked== b, H~2~O and X^2^');
    expect(html).toContain('<mark>marked</mark>');
    expect(html).toContain('H<sub>2</sub>O');
    expect(html).toContain('X<sup>2</sup>');
  });

  it('renders curated emoji shortcodes and linkifies bare URLs', () => {
    const html = render('feeling :joy: — see https://example.com/x');
    expect(html).toContain('feeling 😂');
    expect(html).toContain('<a href="https://example.com/x">');
  });

  it('keeps code spans unlinked (disabling automatic URL linking)', () => {
    const html = render('`https://example.com`');
    expect(html).not.toContain('<a href');
  });

  it('renders callouts as the styled box with title bar', () => {
    const html = render('> [!NOTE] Custom title\n> body');
    expect(html).toContain('<div class="callout callout-note">');
    expect(html).toContain('callout-title');
    expect(html).toContain('Custom title');
    expect(html).toContain('body');
    expect(html).not.toContain('[!NOTE]');
  });

  it('renders footnotes with a footnotes section', () => {
    const html = render('A claim[^1]\n\n[^1]: The note');
    expect(html).toContain('footnote-ref');
    expect(html).toContain('The note');
  });

  it('emits math placeholders and embeds the katex runtime only for math notes', () => {
    const math = render('inline $x^2$ and display\n\n$$\nE=mc^2\n$$\n');
    expect(math).toContain('<span class="drey-math" data-display="0">x^2</span>');
    expect(math).toContain('data-display="1"');
    // No runtime handed over: nothing inlined, LaTeX stays visible.
    expect(math).not.toContain('<script');

    const withRuntime = buildNotePdfHtml({
      markdown: '$x^2$',
      katexRuntime: { script: 'window.katex={};', css: '/*katex*/' },
    });
    expect(withRuntime).toContain('window.katex={};');
    expect(withRuntime).toContain('/*katex*/');
    // The bootstrap is inlined (synchronous — no settle promise needed).
    expect(withRuntime).toContain('throwOnError: true');
  });

  it('embeds no katex runtime for a note without math', () => {
    const html = buildNotePdfHtml({
      markdown: 'plain text',
      katexRuntime: { script: 'window.katex={};', css: '/*katex*/' },
    });
    expect(html).not.toContain('window.katex');
  });

  it('the paper stylesheet carries the extended-syntax rules', () => {
    const css = render('# t');
    expect(css).toContain('.callout-title');
    expect(css).toContain('.footnotes-sep');
    expect(css).toContain('.drey-math-error');
    expect(css).toContain('mark {');
  });
});

describe('KATEX_BOOTSTRAP (executed in a real iframe)', () => {
  interface StubKatex {
    render: (latex: string, el: Element, opts: Record<string, unknown>) => void;
  }
  interface FrameWindow {
    katex?: StubKatex;
  }

  const frames: HTMLIFrameElement[] = [];

  afterEach(() => {
    while (frames.length > 0) {
      frames.pop()?.remove();
    }
  });

  function mount(bodyHtml: string): { doc: Document; win: FrameWindow } {
    const frame = document.createElement('iframe');
    frames.push(frame);
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><body>${bodyHtml}</body></html>`);
    doc.close();
    return { doc, win: frame.contentWindow as unknown as FrameWindow };
  }

  function run(doc: Document): void {
    const script = doc.createElement('script');
    script.textContent = KATEX_BOOTSTRAP;
    doc.body.appendChild(script);
  }

  it('typesets every placeholder with its display mode', () => {
    const { doc, win } = mount(
      '<p><span class="drey-math" data-display="0">x^2</span></p>' +
        '<span class="drey-math" data-display="1">E=mc^2</span>',
    );
    const calls: Array<[string, boolean]> = [];
    win.katex = {
      render: (latex, el, opts) => {
        calls.push([latex, Boolean(opts['displayMode'])]);
        el.textContent = `typeset:${latex}`;
      },
    };
    run(doc);
    expect(calls).toEqual([
      ['x^2', false],
      ['E=mc^2', true],
    ]);
    expect(doc.body.textContent).toContain('typeset:x^2');
  });

  it('a parse error keeps the LaTeX visible and flags the span', () => {
    const { doc, win } = mount('<span class="drey-math" data-display="0">\\broken{</span>');
    win.katex = {
      render: () => {
        throw new Error('Expected }');
      },
    };
    run(doc);
    const span = doc.querySelector('.drey-math');
    expect(span?.classList.contains('drey-math-error')).toBe(true);
    expect(span?.textContent).toBe('\\broken{');
  });

  it('without a katex global nothing happens', () => {
    const { doc } = mount('<span class="drey-math" data-display="0">x</span>');
    run(doc);
    expect(doc.querySelector('.drey-math')?.textContent).toBe('x');
  });
});

describe('MERMAID_BOOTSTRAP (executed in a real iframe)', () => {
  interface StubMermaid {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, source: string) => Promise<{ svg: string }>;
  }
  interface FrameWindow {
    mermaid?: StubMermaid;
    __dreyMermaidSettled?: Promise<unknown>;
  }

  const frames: HTMLIFrameElement[] = [];

  afterEach(() => {
    while (frames.length > 0) {
      frames.pop()?.remove();
    }
  });

  /** An about:blank iframe with the given body; the bootstrap runs against it. */
  function mount(bodyHtml: string): { doc: Document; win: FrameWindow } {
    const frame = document.createElement('iframe');
    frames.push(frame);
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><body>${bodyHtml}</body></html>`);
    doc.close();
    const win = frame.contentWindow as unknown as FrameWindow;
    return { doc, win };
  }

  function run(doc: Document): void {
    const script = doc.createElement('script');
    script.textContent = MERMAID_BOOTSTRAP;
    doc.body.appendChild(script); // executes synchronously
  }

  /** A stub that renders every source, "leaking" mermaid's `d<id>` node. */
  function stubMermaid(doc: Document, rendered: string[], broken?: string): StubMermaid {
    return {
      initialize: () => undefined,
      render: (id: string, source: string) => {
        rendered.push(source);
        const leftover = doc.createElement('div');
        leftover.id = `d${id}`;
        doc.body.appendChild(leftover);
        if (broken !== undefined && source.includes(broken)) {
          return Promise.reject(new Error('Parse error'));
        }
        return Promise.resolve({ svg: `<svg><text>${source}</text></svg>` });
      },
    };
  }

  it('replaces a renderable fence with the figure and cleans the measuring node', async () => {
    const { doc, win } = mount('<pre><code class="language-mermaid">graph TD\nA-->B</code></pre>');
    const rendered: string[] = [];
    win.mermaid = stubMermaid(doc, rendered);
    run(doc);

    await win.__dreyMermaidSettled;
    expect(rendered).toEqual(['graph TD\nA-->B']);
    const figures = doc.querySelectorAll('figure.mermaid-figure');
    expect(figures.length).toBe(1);
    expect(figures[0].querySelector('svg text')?.textContent).toBe('graph TD\nA-->B');
    expect(doc.querySelector('pre')).toBeNull();
    // mermaid's offscreen node is gone again.
    expect(doc.querySelectorAll('div[id^="d"]').length).toBe(0);
  });

  it('a parse error leaves the code block in place', async () => {
    const { doc, win } = mount('<pre><code class="language-mermaid">BROKEN</code></pre>');
    win.mermaid = stubMermaid(doc, [], 'BROKEN');
    run(doc);

    await win.__dreyMermaidSettled;
    expect(doc.querySelector('figure')).toBeNull();
    const code = doc.querySelector('pre > code');
    expect(code?.textContent).toBe('BROKEN');
  });

  it('without a mermaid global nothing happens at all', () => {
    const { doc, win } = mount('<pre><code class="language-mermaid">graph TD</code></pre>');
    run(doc);

    expect(win.__dreyMermaidSettled).toBeUndefined();
    expect(doc.querySelector('pre > code')?.textContent).toBe('graph TD');
  });

  it('non-mermaid code blocks are untouched', async () => {
    const { doc, win } = mount('<pre><code class="language-js">let x = 1;</code></pre>');
    const rendered: string[] = [];
    win.mermaid = stubMermaid(doc, rendered);
    run(doc);

    await win.__dreyMermaidSettled;
    expect(rendered).toEqual([]);
    expect(doc.querySelector('pre > code')?.textContent).toBe('let x = 1;');
  });
});
