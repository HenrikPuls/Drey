/**
 * The tag search matcher: given the tagged sections and a query, return the
 * sections where **every** requested tag is present and **every** free-text
 * term appears (in the section body or its heading), each with a compact
 * snippet. Pure -- `electron/tags` feeds it the index, the renderer's
 * search panel renders the hits.
 */

/** A section the matcher can search. `SectionRecord` (electron) satisfies this. */
export interface SearchableSection {
  path: string;
  heading: string;
  line: number;
  tags: readonly string[];
  text: string;
}

export interface TagSearchQuery {
  /** Tags that must all be present in a section (AND). */
  tags: readonly string[];
  /** Free text; whitespace-split into terms that must all appear. */
  text: string;
}

export interface TagSearchHit {
  path: string;
  heading: string;
  /** 1-based line the section starts on -- where a click should land. */
  line: number;
  /** ~240-char window around the first match, whitespace collapsed. */
  snippet: string;
  /** The full section body (heading excluded) -- used by the doc export. */
  text: string;
}

const SNIPPET_WINDOW = 240;
const SNIPPET_LEAD = 60;

export function runTagSearch(
  sections: readonly SearchableSection[],
  query: TagSearchQuery,
): TagSearchHit[] {
  const tags = dedupeLower(query.tags);
  const terms = query.text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');

  // Nothing to search for.
  if (tags.length === 0 && terms.length === 0) {
    return [];
  }

  const needles = [...terms, ...tags.map((t) => `#${t}`)];
  const hits: TagSearchHit[] = [];

  for (const section of sections) {
    const sectionTags = new Set(section.tags.map((t) => t.toLowerCase()));
    // A requested tag matches exactly OR as the parent of a nested tag:
    // searching `#project` also returns `#project/frontend` sections.
    if (!tags.every((t) => sectionHasTagOrChild(sectionTags, t))) {
      continue;
    }
    const hay = `${section.heading}\n${section.text}`.toLowerCase();
    if (!terms.every((term) => hay.includes(term))) {
      continue;
    }
    hits.push({
      path: section.path,
      heading: section.heading,
      line: section.line,
      snippet: makeSnippet(section.text, needles),
      text: section.text,
    });
  }

  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return hits;
}

/**
 * A Markdown document listing the search hits: a header line describing the
 * query, then one `## <path>:<line>` section per hit followed by its full
 * text. No LLM -- this is the always-available alternative to the digest.
 */
export function formatSearchResultsDoc(
  query: TagSearchQuery,
  hits: readonly TagSearchHit[],
): string {
  const parts: string[] = [];
  const tags = query.tags.map((t) => `#${t.replace(/^#/, '')}`).join(' ');
  const text = query.text.trim();
  const queryDesc = [tags, text ? `"${text}"` : ''].filter((s) => s !== '').join(' + ');

  parts.push('# Search results');
  parts.push(
    `${queryDesc || '(everything)'} — ${hits.length} ${hits.length === 1 ? 'section' : 'sections'}`,
  );

  for (const hit of hits) {
    parts.push(`## ${hit.path}:${hit.line}`);
    parts.push(hit.text.trim());
  }

  return `${parts.join('\n\n')}\n`;
}

function makeSnippet(text: string, needles: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();

  let at = -1;
  for (const needle of needles) {
    const i = lower.indexOf(needle);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
    }
  }

  if (at === -1) {
    return flat.length > SNIPPET_WINDOW ? `${flat.slice(0, SNIPPET_WINDOW).trimEnd()}…` : flat;
  }

  const start = Math.max(0, at - SNIPPET_LEAD);
  const end = Math.min(flat.length, start + SNIPPET_WINDOW);
  let snippet = flat.slice(start, end).trim();
  if (start > 0) {
    snippet = `…${snippet}`;
  }
  if (end < flat.length) {
    snippet = `${snippet}…`;
  }
  return snippet;
}

/** `wanted` is present exactly, or a `wanted/…` nested tag is (label hierarchy). */
function sectionHasTagOrChild(sectionTags: ReadonlySet<string>, wanted: string): boolean {
  if (sectionTags.has(wanted)) {
    return true;
  }
  const prefix = `${wanted}/`;
  for (const t of sectionTags) {
    if (t.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function dedupeLower(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.trim().toLowerCase().replace(/^#/, '');
    if (key !== '') {
      seen.add(key);
    }
  }
  return [...seen];
}
