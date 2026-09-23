import { buildOutlineTree, parentKeys, scanOutline } from './outline';

/**
 * The outline scanner + tree builder: ATX-only, fence-aware, frontmatter
 * skipped — same conventions as the tags/tasks section scanners.
 */

const doc = (...lines: string[]): string => lines.join('\n');

describe('scanOutline', () => {
  it('returns no entries for an empty or headingless document', () => {
    expect(scanOutline('')).toEqual([]);
    expect(scanOutline('plain text\nmore text\n')).toEqual([]);
  });

  it('reports level, title and 1-based line for every ATX heading', () => {
    const entries = scanOutline(doc('# Top', '', 'body', '## Sub', '### Deep', '#### Four'));
    expect(entries).toEqual([
      { level: 1, title: 'Top', line: 1 },
      { level: 2, title: 'Sub', line: 4 },
      { level: 3, title: 'Deep', line: 5 },
      { level: 4, title: 'Four', line: 6 },
    ]);
  });

  it('strips closing hashes and surrounding spaces', () => {
    expect(scanOutline('# Title ##')[0]).toMatchObject({ title: 'Title' });
    expect(scanOutline('##  Spaced  #  ')[0]).toMatchObject({ title: 'Spaced' });
  });

  it('ignores lines without a space after the hashes and seven hashes', () => {
    expect(scanOutline('#tag not-a-heading')).toEqual([]);
    expect(scanOutline('####### seven is too many')).toEqual([]);
  });

  it('ignores setext underlines', () => {
    expect(scanOutline(doc('Title', '====', '', 'Sub', '----'))).toEqual([]);
  });

  it('skips headings inside fenced code blocks (backticks and tildes)', () => {
    const entries = scanOutline(
      doc('# Real', '```md', '## Fake', '```', '~~~', '### Also fake', '~~~', '## Also real'),
    );
    expect(entries.map((e) => e.title)).toEqual(['Real', 'Also real']);
    expect(entries.map((e) => e.line)).toEqual([1, 8]);
  });

  it('skips a `#` line inside an indented fence', () => {
    const entries = scanOutline(doc('# Real', '  ```', '## Indented fence', '  ```'));
    expect(entries.map((e) => e.title)).toEqual(['Real']);
  });

  it('skips YAML frontmatter including its `#` comments', () => {
    const entries = scanOutline(
      doc('---', 'kind: note', '# not a heading', '---', '# Real', 'body'),
    );
    expect(entries).toEqual([{ level: 1, title: 'Real', line: 5 }]);
  });

  it('accepts `...` as the frontmatter closing delimiter', () => {
    const entries = scanOutline(doc('---', 'kind: note', '...', '# Real'));
    expect(entries).toEqual([{ level: 1, title: 'Real', line: 4 }]);
  });

  it('treats an unclosed frontmatter block as the whole document', () => {
    expect(scanOutline(doc('---', 'kind: note', '# never reached'))).toEqual([]);
  });

  it('ignores a `---` line in the body (thematic break, not frontmatter)', () => {
    const entries = scanOutline(doc('# Real', '---', 'body'));
    expect(entries).toEqual([{ level: 1, title: 'Real', line: 1 }]);
  });
});

describe('buildOutlineTree', () => {
  it('nests every deeper heading under the nearest shallower one', () => {
    const nodes = buildOutlineTree(
      scanOutline(doc('# A', '## A1', '### A1a', '## A2', '# B', '## B1')),
    );
    expect(nodes.map((n) => n.entry.title)).toEqual(['A', 'B']);
    const a = nodes[0];
    expect(a.children.map((n) => n.entry.title)).toEqual(['A1', 'A2']);
    expect(a.children[0].children[0].entry.title).toEqual('A1a');
  });

  it('nests any deeper heading under the nearest shallower one (section semantics)', () => {
    const nodes = buildOutlineTree(scanOutline(doc('# A', 'text', '### Odd', '## Two')));
    // The H3 and the following H2 both sit inside A's section.
    expect(nodes.map((n) => n.entry.title)).toEqual(['A']);
    expect(nodes[0].children.map((n) => n.entry.level)).toEqual([3, 2]);
  });

  it('gives duplicate titles distinct stable keys', () => {
    const entries = scanOutline(doc('# Notes', '## Same', '## Same', '# More', '## Same'));
    const nodes = buildOutlineTree(entries);
    const keys = [
      nodes[0].children[0].key,
      nodes[0].children[1].key,
      nodes[1].children[0].key,
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps keys stable when line numbers shift between re-scans', () => {
    const before = buildOutlineTree(scanOutline(doc('# A', '## B', 'body', '## C')));
    const after = buildOutlineTree(
      scanOutline(doc('new', 'lines', '# A', '## B', 'body', '## C')),
    );
    const flat = (nodes: typeof before): string[] => {
      const out: string[] = [];
      const walk = (list: typeof nodes): void => {
        for (const n of list) {
          out.push(n.key);
          walk(n.children);
        }
      };
      walk(nodes);
      return out;
    };
    expect(flat(after)).toEqual(flat(before));
  });
});

describe('parentKeys', () => {
  it('lists every node that has children, depth-first', () => {
    const nodes = buildOutlineTree(scanOutline(doc('# A', '## A1', '### deep', '# B', 'plain')));
    expect(parentKeys(nodes)).toEqual([nodes[0].key, nodes[0].children[0].key]);
  });
});
