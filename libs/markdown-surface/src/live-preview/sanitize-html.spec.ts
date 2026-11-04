import { sanitizeHtml } from './sanitize-html';

const passThrough = { resolveImage: (url: string) => `resolved:${url}` };

describe('sanitizeHtml', () => {
  it('keeps presentational markup', () => {
    const html = sanitizeHtml(
      '<div class="note"><b>bold</b> and <table><tr><td>cell</td></tr></table></div>',
      passThrough,
    );
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<td>cell</td>');
    expect(html).toContain('class="note"');
  });

  it('removes script/style elements entirely', () => {
    const html = sanitizeHtml('<div>ok<script>alert(1)</script><style>*{}</style></div>', {
      resolveImage: () => null,
    });
    expect(html).toBe('<div>ok</div>');
  });

  it('strips on* handlers and javascript: hrefs', () => {
    const html = sanitizeHtml(
      '<a href="javascript:alert(1)" onclick="x()">link</a><a href="https://x.test">ok</a>',
      passThrough,
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://x.test"');
  });

  it('unwraps unknown tags but sanitizes their children first', () => {
    const html = sanitizeHtml('<font color="red"><script>x()</script>text</font>', passThrough);
    expect(html).toBe('text');
  });

  it('routes img src through the resolver and drops unresolvable ones', () => {
    expect(sanitizeHtml('<img src="pic.png" alt="p">', passThrough)).toContain(
      'src="resolved:pic.png"',
    );
    expect(sanitizeHtml('<img src="../../x.png">', { resolveImage: () => null })).not.toContain(
      'src',
    );
  });

  it('allows simple styles but rejects url() smuggling', () => {
    expect(sanitizeHtml('<span style="color: red">x</span>', passThrough)).toContain('style=');
    expect(
      sanitizeHtml('<span style="background: url(https://evil.test)">x</span>', passThrough),
    ).not.toContain('style=');
  });
});
