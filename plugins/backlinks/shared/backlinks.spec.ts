import { describe, expect, it } from 'vitest';
import { extractLinkTargets } from './link-targets.js';
import { buildNoteIndex, collectBacklinks, resolveTargetLink } from './link-index.js';

describe('extractLinkTargets', () => {
  it('parses target, anchor and skips aliases (twin of the base grammar)', () => {
    const links = extractLinkTargets('See [[Plan]] and [[docs/note.md#Goals|the goals]].');
    expect(links.map((l) => ({ target: l.target, anchor: l.anchor }))).toEqual([
      { target: 'Plan', anchor: null },
      { target: 'docs/note.md', anchor: 'Goals' },
    ]);
  });

  it('counts embeds as links and reports line, heading and snippet', () => {
    const links = extractLinkTargets('# Log\n\n## Trip\n\nWent to ![[kehl]] by bike.');
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('kehl');
    expect(links[0]?.line).toBe(5);
    expect(links[0]?.heading).toBe('Trip');
    expect(links[0]?.snippet).toContain('![[kehl]]');
  });

  it('skips frontmatter, fenced code and inline code', () => {
    const content = [
      '---',
      'note: a',
      '---',
      '```',
      '[[in-fence]]',
      '```',
      'Inline `[[in-span]]` code.',
      '',
      'Real [[target]] link.',
      '',
    ].join('\n');
    const links = extractLinkTargets(content);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('target');
    expect(links[0]?.line).toBe(9);
    expect(links[0]?.heading).toBe('');
  });

  it('skips same-file anchors and empty brackets', () => {
    expect(extractLinkTargets('[[#Heading]] and [[]] and [[|x]]')).toEqual([]);
  });

  it('caps long snippets', () => {
    const long = 'x'.repeat(300);
    const [link] = extractLinkTargets(`[[target]] ${long}`);
    expect(link?.snippet.length).toBeLessThanOrEqual(161);
    expect(link?.snippet.endsWith('…')).toBe(true);
  });
});

describe('resolveTargetLink (parity twin of WikilinkService.resolve)', () => {
  const index = buildNoteIndex(['Daily/2026-10-09.md', 'Projects/Plan.md', 'Notes/Plan.md', 'a.md']);

  it('treats bare names as basenames and appends .md', () => {
    expect(resolveTargetLink('plan', 'a.md', index)).toBe('Notes/Plan.md');
    expect(resolveTargetLink('2026-10-09', null, index)).toBe('Daily/2026-10-09.md');
  });

  it('treats slash/extension targets as paths, case-insensitively', () => {
    expect(resolveTargetLink('projects/plan', 'a.md', index)).toBe('Projects/Plan.md');
    expect(resolveTargetLink('Projects/Plan.md', 'a.md', index)).toBe('Projects/Plan.md');
    expect(resolveTargetLink('Projects/Plan.markdown', 'a.md', index)).toBeNull();
  });

  it('prefers a sibling on basename ambiguity, else the shortest path', () => {
    expect(resolveTargetLink('plan', 'Notes/x.md', index)).toBe('Notes/Plan.md');
    expect(resolveTargetLink('plan', null, index)).toBe('Notes/Plan.md');
    const flat = buildNoteIndex(['aa/plan.md', 'a/plan.md']);
    expect(resolveTargetLink('plan', null, flat)).toBe('a/plan.md');
  });

  it('resolves an empty target to the linking note itself', () => {
    expect(resolveTargetLink('', 'a.md', index)).toBe('a.md');
  });
});

describe('collectBacklinks', () => {
  it('collects what resolves to the target, excludes self-links, sorts', () => {
    const index = buildNoteIndex(['plan.md', 'a.md', 'b/z.md']);
    const outlinks = new Map([
      ['plan.md', extractLinkTargets('self [[plan]]')],
      ['b/z.md', extractLinkTargets('# Z\nSee [[plan]] and [[Plan]].')],
      ['a.md', extractLinkTargets('No link here.')],
    ]);
    const rows = collectBacklinks('plan.md', outlinks, index);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: 'b/z.md', line: 2, heading: 'Z' });
    expect(rows.map((r) => r.path)).toEqual(['b/z.md', 'b/z.md']);
  });

  it('assigns an ambiguous name to exactly the note the editor would open', () => {
    const index = buildNoteIndex(['x/plan.md', 'y/plan.md']);
    const outlinks = new Map([['root.md', extractLinkTargets('[[plan]]')]]);
    // Same length, locale compare wins: x/plan.md is the deterministic
    // pick — only it shows the backlink (not both twins).
    expect(collectBacklinks('x/plan.md', outlinks, index)).toHaveLength(1);
    expect(collectBacklinks('y/plan.md', outlinks, index)).toHaveLength(0);
    const shorter = buildNoteIndex(['xx/plan.md', 'y/plan.md']);
    expect(collectBacklinks('y/plan.md', outlinks, shorter)).toHaveLength(1);
  });

  it('returns nothing for an unknown path', () => {
    const index = buildNoteIndex(['a.md']);
    expect(collectBacklinks('nope.md', new Map(), index)).toEqual([]);
  });
});
