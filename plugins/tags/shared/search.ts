// Sibling specifiers need the explicit `.js`: this file is emitted BOTH as
// CJS (main, where Node16 maps .js -> .ts) and as ESM served over plugin://
// (where the browser resolves the specifier verbatim — extensionless 404s).
import { extractInlineTags } from './tags.js';
import { splitSections } from './sections.js';

export interface TagEntry {
  tag: string;
  count: number;
}

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
  /**
   * Matcher flags (milestone 33, structurally the SDK's `TextMatchOptions`).
   * Absent = the historical behavior: case-insensitive substring terms.
   */
  match?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
  };
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
  /**
   * Set by the renderer when the hit comes from an open tab's unsaved
   * buffer rather than the file on disk.
   */
  unsaved?: boolean;
  /**
   * The hit's vault id (milestone 33, mirrors the SDK's
   * `TagSearchHit.vaultId`): the per-vault index stamps every on-disk hit,
   * so a cross-vault click opens the right file.
   */
  vaultId?: string;
}

/**
 * True when `path` is an assistant chat note (`chats/…`, ADR-0048). The
 * plugin-local twin of `shared/structural-folders.ts`' `isChatNotePath`:
 * plugin renderer modules load unbundled over `plugin://` and cannot take
 * a runtime import from base `shared/`.
 */
export function isChatNotePath(path: string): boolean {
  return path === 'chats' || path.startsWith('chats/');
}

/**
 * The Search panel's "Include chats" view filter: chat transcripts stay
 * indexed, but drop out of a result list unless the user asked for them.
 */
export function filterChatHits<T extends { path: string }>(
  hits: readonly T[],
  includeChats: boolean,
): T[] {
  return includeChats ? [...hits] : hits.filter((hit) => !isChatNotePath(hit.path));
}

const SNIPPET_WINDOW = 240;
const SNIPPET_LEAD = 60;

/** How the free-text half of a query matches: ready, or a compile error. */
export type TextMatcher =
  | { ok: true; matches: (hay: string) => boolean }
  | { ok: false; error: string };

const WORD_BOUNDARY = String.raw`(?<![\p{L}\p{N}_])`;

/**
 * Builds the free-text matcher for a query (milestone 33). Plain mode:
 * whitespace-split terms, each a case-insensitive substring (historical) or,
 * with `wholeWord`, a Unicode word-boundary-wrapped pattern; `caseSensitive`
 * keeps the original case. Regex mode: the WHOLE trimmed text is one
 * pattern (`u` flag; case-insensitive unless `caseSensitive`; `wholeWord`
 * is ignored — the pattern authors its own boundaries). An invalid pattern
 * surfaces as `{ ok: false, error }` — callers show it, they don't swallow
 * it.
 */
export function buildTextMatcher(query: TagSearchQuery): TextMatcher {
  const text = query.text.trim();
  const caseSensitive = query.match?.caseSensitive === true;
  const wholeWord = query.match?.wholeWord === true;

  if (query.match?.regex === true) {
    if (text === '') {
      return { ok: true, matches: () => true };
    }
    try {
      const re = new RegExp(text, `u${caseSensitive ? '' : 'i'}`);
      return { ok: true, matches: (hay) => re.test(hay) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const terms = (caseSensitive ? text : text.toLowerCase())
    .split(/\s+/)
    .filter((t) => t !== '');
  if (terms.length === 0) {
    return { ok: true, matches: () => true };
  }

  if (!wholeWord) {
    return { ok: true, matches: (hay) => terms.every((term) => hay.includes(term)) };
  }

  // No `g` flag: `test()` would carry `lastIndex` across calls/haystacks.
  const patterns = terms.map((term) => new RegExp(`${WORD_BOUNDARY}${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, `u${caseSensitive ? '' : 'i'}`));
  return { ok: true, matches: (hay) => patterns.every((re) => re.test(hay)) };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runTagSearch(
  sections: readonly SearchableSection[],
  query: TagSearchQuery,
): TagSearchHit[] {
  const tags = dedupeLower(query.tags);
  const matcher = buildTextMatcher(query);
  // A query whose regex does not compile matches nothing — callers
  // pre-validate through `buildTextMatcher` and show the error instead.
  if (!matcher.ok) {
    return [];
  }
  const terms = query.text
    .trim()
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
    if (!tags.every((t) => tagSetMatches(sectionTags, t))) {
      continue;
    }
    const hay = caseSensitiveHay(section, query);
    if (!matcher.matches(hay)) {
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

function caseSensitiveHay(section: SearchableSection, query: TagSearchQuery): string {
  const raw = `${section.heading}\n${section.text}`;
  return query.match?.caseSensitive === true ? raw : raw.toLowerCase();
}

/** 1-based inclusive line range (a section's heading line through its body). */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Applies the query's replacement to the given line ranges (milestone 33's
 * cross-file replace). Only occurrences INSIDE the ranges are touched — the
 * sections the search matched, never the rest of the file — and the ranges
 * are applied as a batch (a replacement that itself contains a search term
 * cannot be re-replaced). Line-level by design: a pattern that would span a
 * line break matches for the search but is not replaced.
 *
 * Returns the new line array plus the total occurrence count, or the
 * matcher's compile error.
 */
export function replaceInRanges(
  lines: readonly string[],
  query: TagSearchQuery,
  replacement: string,
  ranges: readonly LineRange[],
): { ok: true; lines: string[]; occurrences: number } | { ok: false; error: string } {
  const matcher = buildTextMatcher(query);
  if (!matcher.ok) {
    return { ok: false, error: matcher.error };
  }

  const out = [...lines];
  let occurrences = 0;
  const caseSensitive = query.match?.caseSensitive === true;
  const wholeWord = query.match?.wholeWord === true;
  const regexMode = query.match?.regex === true;
  const text = query.text.trim();
  if (text === '') {
    return { ok: true, lines: out, occurrences: 0 };
  }

  for (const range of ranges) {
    for (let i = range.start - 1; i <= Math.min(range.end - 1, out.length - 1); i++) {
      const line = out[i];
      if (line === undefined) {
        continue;
      }
      const applied = applyToLine(line, query, replacement, { caseSensitive, wholeWord, regexMode });
      out[i] = applied.line;
      occurrences += applied.count;
    }
  }
  return { ok: true, lines: out, occurrences };
}

function applyToLine(
  line: string,
  query: TagSearchQuery,
  replacement: string,
  mode: { caseSensitive: boolean; wholeWord: boolean; regexMode: boolean },
): { line: string; count: number } {
  const flags = `gu${mode.caseSensitive ? '' : 'i'}`;

  if (mode.regexMode) {
    const re = new RegExp(query.text.trim(), flags);
    let count = 0;
    const replaced = line.replace(re, () => {
      count++;
      return replacement;
    });
    return { line: replaced, count };
  }

  const terms = (mode.caseSensitive ? query.text.trim() : query.text.trim().toLowerCase())
    .split(/\s+/)
    .filter((t) => t !== '');
  // Work on a case-folded copy unless the query is case-sensitive: the
  // original line is restored via matched-index splicing.
  const haystack = mode.caseSensitive ? line : line.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const term of terms) {
    let re: RegExp;
    try {
      re = mode.wholeWord
        ? new RegExp(`${WORD_BOUNDARY}${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, flags)
        : new RegExp(escapeRegex(term), flags);
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m.index === re.lastIndex) {
        break; // zero-width safety
      }
    }
  }
  if (spans.length === 0) {
    return { line, count: 0 };
  }
  spans.sort((a, b) => a[0] - b[0]);
  let rebuilt = '';
  let cursor = 0;
  let count = 0;
  for (const [from, to] of spans) {
    if (from < cursor) {
      continue; // overlapping term matches: first one wins
    }
    rebuilt += `${line.slice(cursor, from)}${replacement}`;
    cursor = to;
    count++;
  }
  rebuilt += line.slice(cursor);
  return { line: rebuilt, count };
}

/**
 * A Markdown document listing the search hits: a header line describing the
 * query, then one `## <path>:<line>` section per hit followed by its full
 * text. No LLM — the deterministic alternative to the panel's "Summarize"
 * digest (both start from the same hit list).
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

/** Rough character budget for the summarise user message (~15k tokens). */
export const SEARCH_SUMMARY_CHAR_BUDGET = 60_000;

/** One-line human description of a query — the digest header and the prompt. */
export function describeSearchQuery(query: TagSearchQuery): string {
  const parts: string[] = [];
  if (query.tags.length > 0) {
    parts.push(query.tags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' + '));
  }
  const text = query.text.trim();
  if (text !== '') {
    parts.push(`"${text}"`);
  }
  return parts.length === 0 ? '(everything)' : parts.join(' · ');
}

/**
 * The scratch-tab head the digest streams into below (title, query,
 * timestamp line, rule). The timestamp is handed in preformatted — this
 * module is shared by both sides and stays free of clock concerns.
 */
export function formatSearchSummaryHeader(
  query: TagSearchQuery,
  sectionCount: number,
  timestamp: string,
): string {
  return [
    '# Search summary',
    '',
    `Query: ${describeSearchQuery(query)}`,
    `Generated from ${sectionCount} search section${sectionCount === 1 ? '' : 's'} on ${timestamp}. Review before keeping.`,
    '',
    '---',
    '',
  ].join('\n');
}

export interface SearchSummaryMaterial {
  /** The complete user message for the summarise call. */
  message: string;
  /** Sections actually included — a prefix of the hits (whole sections only). */
  included: number;
  total: number;
}

/**
 * Builds the summarise user message (milestone 37): a query line, then
 * every hit as a `### path:line — heading` block with its full section
 * text, up to `budget` characters. Cutting happens at a whole-section
 * boundary and the message says so — the model must not summarize beyond
 * what it was given. The first section always makes it in, however large.
 * Sections spanning several vaults are labelled `vaultId/path` so the
 * digest's path citations stay unambiguous.
 */
export function buildSearchSummaryMaterial(
  query: TagSearchQuery,
  hits: readonly TagSearchHit[],
  budget: number = SEARCH_SUMMARY_CHAR_BUDGET,
): SearchSummaryMaterial {
  const multiVault =
    new Set(hits.map((hit) => hit.vaultId).filter((id) => id !== undefined)).size > 1;
  const blocks: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const where =
      (multiVault && hit.vaultId !== undefined ? `${hit.vaultId}/${hit.path}` : hit.path) +
      `:${hit.line}`;
    const heading = hit.heading === '' ? '' : ` — ${hit.heading}`;
    const block = `### ${where}${heading}\n${hit.text.trim()}`;
    const cost = block.length + 2;
    if (blocks.length > 0 && used + cost > budget) {
      break;
    }
    blocks.push(block);
    used += cost;
  }
  const intro = [
    `Search query: ${describeSearchQuery(query)}`,
    `Sections: ${blocks.length}${
      blocks.length < hits.length
        ? ` of ${hits.length} — the remaining sections exceeded the content budget and are NOT included`
        : ''
    }`,
    '',
    'Write the digest from ONLY these sections:',
  ];
  return {
    message: [...intro, '', blocks.join('\n\n')].join('\n'),
    included: blocks.length,
    total: hits.length,
  };
}

/**
 * The `## Sources` section appended under the digest: one line per section
 * the material actually included (same order, same whole-section cut —
 * `included` is a prefix length of `hits`), carrying a `[[wikilink]]` to
 * the section. Deterministic on purpose — the model never mints links
 * (anchors must match a real heading, and sections without one cannot be
 * anchored at all). The link target is the extension-less path
 * (Obsidian-style; a non-`.md` extension stays so the target still
 * resolves) plus a `#heading` anchor when the section has one — wikilinks
 * have no line anchor, so the exact line rides the plain label after the
 * dash. With `vaultNames` given and the hits spanning more than one
 * vault, each label is prefixed with the vault's name; the link itself
 * cannot say which vault it means (when two vaults hold the same relative
 * path, the active one wins — a documented limitation). Returns '' when
 * nothing was included.
 */
export function buildSearchSummarySources(
  hits: readonly TagSearchHit[],
  included: number,
  vaultNames: Readonly<Record<string, string>> = {},
): string {
  const used = hits.slice(0, Math.max(0, Math.min(included, hits.length)));
  if (used.length === 0) {
    return '';
  }
  const multiVault =
    new Set(used.map((hit) => hit.vaultId).filter((id) => id !== undefined)).size > 1;
  const lines: string[] = [];
  for (const hit of used) {
    const path = hit.path.replace(/\\/g, '/');
    const target = /\.md$/i.test(path) ? path.replace(/\.[^/]+$/, '') : path;
    const anchor = hit.heading !== '' && !/[\][|]/.test(hit.heading) ? `#${hit.heading}` : '';
    const vault =
      multiVault && hit.vaultId !== undefined ? `${vaultNames[hit.vaultId] ?? hit.vaultId} · ` : '';
    lines.push(`- [[${target}${anchor}]] — ${vault}${path}:${hit.line}`);
  }
  return `\n\n## Sources\n\n${lines.join('\n')}\n`;
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

/**
 * Whether a tag set satisfies a single query tag: `wanted` is present
 * exactly, or a `wanted/…` nested tag is (label hierarchy) -- so a query
 * for `#project` is also matched by a `#project/frontend` tag. `tags` is
 * expected to be lower-cased already. Shared by the section search and the
 * Tasks panel filter so the "nested tag" rule stays single-sourced.
 */
export function tagSetMatches(tags: ReadonlySet<string>, wanted: string): boolean {
  if (tags.has(wanted)) {
    return true;
  }
  const prefix = `${wanted}/`;
  for (const t of tags) {
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

/**
 * The cross-file replace patch for ONE file's content (milestone 33): the
 * sections satisfying the query — computed fresh from THIS content — get
 * the replacement applied within their line ranges; the rest of the file is
 * untouched. Line-level by design (a pattern spanning a line break matches
 * for the search but is not replaced). LF content expected; the caller
 * handles CRLF restore. `null` when nothing matches (or the regex broke —
 * pre-validate through `buildTextMatcher` to show that).
 */
export function patchContent(
  content: string,
  query: TagSearchQuery,
  replacement: string,
): { before: string; after: string; occurrences: number; sections: number } | null {
  const matcher = buildTextMatcher(query);
  if (!matcher.ok) {
    return null;
  }
  const sections = splitSections(content);
  if (sections.length === 0) {
    return null;
  }
  const lineCount = content.split('\n').length;
  const ranges: LineRange[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionTags = new Set(extractInlineTags(`${section.heading}\n${section.text}`));
    if (!query.tags.every((t) => tagSetMatches(sectionTags, t))) {
      continue;
    }
    const hay = `${section.heading}\n${section.text}`;
    if (!matcher.matches(query.match?.caseSensitive === true ? hay : hay.toLowerCase())) {
      continue;
    }
    const end =
      i + 1 < sections.length ? sections[i + 1].line - 1 : Math.max(lineCount, section.line);
    ranges.push({ start: section.line, end });
  }
  if (ranges.length === 0) {
    return null;
  }
  const replaced = replaceInRanges(content.split('\n'), query, replacement, ranges);
  if (!replaced.ok || replaced.occurrences === 0) {
    return null;
  }
  return {
    before: content,
    after: replaced.lines.join('\n'),
    occurrences: replaced.occurrences,
    sections: ranges.length,
  };
}
