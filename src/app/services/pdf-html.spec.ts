import {
  buildNotePdfHtml,
  replaceTaskMarkers,
  rewriteEmbedWikilinks,
  stripActiveHtml,
} from '../../../shared/pdf-html';

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
