/**
 * `vault_search` and `vault_retrieve` (ADR-0071).
 *
 * `vault_search` is exact matching over the note files themselves — no
 * index of its own (a full-text index was decided against,
 * `specs/decisions.md`): words must all occur in one heading-delimited
 * section, a regular expression matches line by line. Reading the files
 * is what gives every hit its line number, and what lets `path` narrow
 * the search to one note. Only a `tags` filter goes to the section index,
 * which owns the tag grammar.
 *
 * `vault_retrieve` ranks sections by meaning through the semantic seam.
 */
import { splitSections } from '../../../shared/note-sections';
import type { SemanticSectionHit } from '../../../shared/plugin-api';
import { unsavedKey, unsavedTexts } from './current-text';
import { cleanPath, isUnder, ResolvedVaults, ScopedVault, ToolScope } from './scope';
import { fail, McpToolResult, ok, plural, VaultToolDeps } from './types';

const DEFAULT_MAX_RESULTS = 30;
const HARD_MAX_RESULTS = 100;
const MAX_CONTEXT_LINES = 5;
/** Bounds of one scan — a single-user local tool, but still bounded. */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_CHARS_PER_FILE = 512 * 1024;
/** Matching lines shown per section in word mode; the section is the hit. */
const LINES_PER_SECTION = 3;
const LINE_MAX_CHARS = 240;

const RETRIEVE_DEFAULT = 8;
const RETRIEVE_MAX = 20;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, Math.floor(raw)))
    : fallback;
}

function clip(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.length > LINE_MAX_CHARS ? `${trimmed.slice(0, LINE_MAX_CHARS)}…` : trimmed;
}

/** `query` as the terms to look for: quoted phrases stay whole, the rest splits on spaces. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term !== '') {
      terms.push(term);
    }
  }
  return terms;
}

/** One matching line of a file, with the section it sits in. */
interface LineHit {
  line: number;
  heading: string;
}

/** The lines of `content` that match, in order. `matcher` decides per mode. */
export function findLines(
  content: string,
  mode: { kind: 'regex'; regex: RegExp } | { kind: 'words'; terms: string[]; caseSensitive: boolean },
): LineHit[] {
  const lines = content.split('\n');
  const sections = splitSections(content);
  const headingAt = (line: number): string => {
    let heading = '';
    for (const section of sections) {
      if (section.line > line) {
        break;
      }
      heading = section.heading;
    }
    return heading;
  };

  if (mode.kind === 'regex') {
    const hits: LineHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      mode.regex.lastIndex = 0;
      if (mode.regex.test(lines[i])) {
        hits.push({ line: i + 1, heading: headingAt(i + 1) });
      }
    }
    return hits;
  }

  const fold = (text: string): string => (mode.caseSensitive ? text : text.toLowerCase());
  const terms = mode.terms.map(fold);
  // Section bounds: from its first line to the line before the next one.
  // Text before the first heading is a section of its own.
  const starts = sections.map((section) => section.line);
  if (starts[0] !== 1) {
    starts.unshift(1);
  }
  const hits: LineHit[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] - 1 : lines.length;
    const body = fold(lines.slice(from - 1, to).join('\n'));
    if (!terms.every((term) => body.includes(term))) {
      continue;
    }
    const heading = headingAt(from);
    let shown = 0;
    for (let line = from; line <= to && shown < LINES_PER_SECTION; line++) {
      const text = fold(lines[line - 1]);
      if (terms.some((term) => text.includes(term))) {
        hits.push({ line, heading });
        shown++;
      }
    }
  }
  return hits;
}

/** The hits of one file as text: the path and heading, then `line: text` rows with their context. */
function formatFile(
  label: string,
  content: string,
  hits: readonly LineHit[],
  context: number,
): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  let heading: string | null = null;
  let printedUpTo = 0;
  const matched = new Set(hits.map((hit) => hit.line));
  for (const hit of hits) {
    if (hit.heading !== heading) {
      heading = hit.heading;
      out.push(heading === '' ? label : `${label} — ${heading}`);
      printedUpTo = 0;
    }
    const from = Math.max(printedUpTo + 1, hit.line - context);
    const to = Math.min(lines.length, hit.line + context);
    if (context > 0 && printedUpTo > 0 && from > printedUpTo + 1) {
      out.push('  …');
    }
    for (let line = from; line <= to; line++) {
      out.push(`  ${line}${matched.has(line) ? ':' : '-'} ${clip(lines[line - 1])}`);
    }
    printedUpTo = Math.max(printedUpTo, to);
  }
  return out;
}

function describeQuery(query: string, tags: readonly string[], isRegex: boolean): string {
  const parts = [
    ...(query !== '' ? [isRegex ? `/${query}/` : `"${query}"`] : []),
    ...tags.map((tag) => `#${tag}`),
  ];
  return parts.join(' ');
}

async function searchByTags(
  deps: VaultToolDeps,
  scope: ToolScope,
  resolved: ResolvedVaults,
  tags: string[],
  query: string,
  filter: RegExp | null,
  folder: string,
  limit: number,
): Promise<McpToolResult> {
  const provider = deps.getSearchProvider();
  if (provider === null) {
    return fail(
      'Error: searching by tag is unavailable — the Tags plugin is switched off. Search by `query` alone.',
    );
  }
  const blocks: string[] = [];
  let total = 0;
  for (const target of resolved.vaults) {
    const hits = await provider.search(
      { tags, text: filter === null ? query : '' },
      { kind: 'vault', vaultId: target.id },
    );
    for (const hit of hits) {
      const path = hit.path.replace(/\\/g, '/');
      if (!isUnder(path, folder) || scope.isProtected(path)) {
        continue;
      }
      if (filter !== null) {
        filter.lastIndex = 0;
        if (!filter.test(hit.text)) {
          continue;
        }
      }
      total++;
      if (blocks.length < limit) {
        blocks.push(
          `${scope.label(target, path, resolved.labelled)}:${hit.line} — ${hit.heading}\n  ${clip(hit.snippet)}`,
        );
      }
    }
  }
  if (total === 0) {
    return ok(`No sections match ${describeQuery(query, tags, filter !== null)}.`);
  }
  return ok(
    [
      `${plural(total, 'section')} match ${describeQuery(query, tags, filter !== null)}${total > blocks.length ? ` (first ${blocks.length} shown)` : ''}:`,
      '',
      blocks.join('\n\n'),
    ].join('\n'),
  );
}

/** The files a scan covers in one vault: one file when `target` names one, the notes under it otherwise. */
async function scanFiles(
  deps: VaultToolDeps,
  scope: ToolScope,
  vault: ScopedVault,
  target: string,
): Promise<string[]> {
  const notes = (await deps.vault.listMarkdownFiles(vault.id))
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => !scope.isProtected(file));
  if (target !== '' && notes.includes(target)) {
    return [target];
  }
  const under = notes.filter((file) => isUnder(file, target));
  if (under.length === 0 && target !== '' && /\.[a-z0-9]+$/i.test(target)) {
    // A single file that is not a note (a .txt, a .json): search it as it is.
    return scope.isProtected(target) ? [] : [target];
  }
  return under;
}

export async function vaultSearch(
  deps: VaultToolDeps,
  scope: ToolScope,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const resolved = scope.many(args['vault']);
  if ('error' in resolved) {
    return fail(resolved.error);
  }
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  const tags = Array.isArray(args['tags'])
    ? (args['tags'] as unknown[])
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().replace(/^#/, ''))
        .filter((tag) => tag !== '')
    : [];
  if (query === '' && tags.length === 0) {
    return fail('Error: vault_search needs `query`, `tags`, or both.');
  }
  const caseSensitive = args['case_sensitive'] === true;
  const isRegex = args['regex'] === true && query !== '';
  let regex: RegExp | null = null;
  if (isRegex) {
    try {
      regex = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err) {
      return fail(
        `Error: \`query\` is not a valid regular expression (${err instanceof Error ? err.message : String(err)}) — correct it, or leave out \`regex\` to search for the words as they are.`,
      );
    }
  }
  const folder = cleanPath(args['path']);
  const limit = clampInt(args['max_results'], DEFAULT_MAX_RESULTS, 1, HARD_MAX_RESULTS);
  const context = clampInt(args['context_lines'], 0, 0, MAX_CONTEXT_LINES);

  if (tags.length > 0) {
    return searchByTags(deps, scope, resolved, tags, query, regex, folder, limit);
  }

  const terms = queryTerms(query);
  // What an open tab holds unsaved is searched in place of its file, so
  // the line numbers match what vault_read shows next.
  const unsaved = await unsavedTexts(deps);
  const out: string[] = [];
  let found = 0;
  let scanned = 0;
  let capped = false;
  let skipped = 0;
  outer: for (const target of resolved.vaults) {
    const files = await scanFiles(deps, scope, target, folder);
    skipped += Math.max(0, files.length - SCAN_MAX_FILES);
    for (const file of files.slice(0, SCAN_MAX_FILES)) {
      let content: string;
      const buffer = unsaved.get(unsavedKey(target.id, file));
      if (buffer !== undefined) {
        content = buffer;
      } else {
        try {
          content = (await deps.vault.readFile(file, target.id)).content.replace(/\r\n/g, '\n');
        } catch {
          continue;
        }
      }
      scanned++;
      if (content.length > SCAN_MAX_CHARS_PER_FILE) {
        content = content.slice(0, SCAN_MAX_CHARS_PER_FILE);
      }
      let hits = findLines(
        content,
        regex !== null ? { kind: 'regex', regex } : { kind: 'words', terms, caseSensitive },
      );
      if (hits.length === 0) {
        continue;
      }
      if (found + hits.length > limit) {
        hits = hits.slice(0, limit - found);
        capped = true;
      }
      found += hits.length;
      if (out.length > 0) {
        out.push('');
      }
      out.push(...formatFile(scope.label(target, file, resolved.labelled), content, hits, context));
      if (capped) {
        break outer;
      }
    }
  }

  const what = describeQuery(query, [], regex !== null);
  if (found === 0) {
    return ok(
      scanned === 0
        ? `No notes to search${folder === '' ? '' : ` under "${folder}"`} — check the path with vault_list.`
        : `No matches for ${what} in ${plural(scanned, 'file')}. Try other or fewer words${terms.length > 1 && regex === null ? ' (all of them must occur in one section)' : ''}.`,
    );
  }
  return ok(
    [
      `${plural(found, 'matching line')} for ${what}:`,
      '',
      ...out,
      ...(capped
        ? ['', `[stopped at ${found} lines — narrow with \`path\`, more words or \`tags\`, or raise \`max_results\`]`]
        : []),
      ...(skipped > 0 ? ['', `[${plural(skipped, 'file')} not searched — narrow with \`path\`]`] : []),
    ].join('\n'),
  );
}

export async function vaultRetrieve(
  deps: VaultToolDeps,
  scope: ToolScope,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const provider = deps.getSemanticProvider();
  if (provider === null) {
    return fail(
      'Error: vault_retrieve is unavailable — semantic retrieval is switched off (Settings → Assistant retrieval). Use vault_search with distinctive words instead.',
    );
  }
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (query === '') {
    return fail('Error: vault_retrieve needs a non-empty `query` — a question or a topic description.');
  }
  const resolved = scope.many(args['vault']);
  if ('error' in resolved) {
    return fail(resolved.error);
  }
  const limit = clampInt(args['limit'], RETRIEVE_DEFAULT, 1, RETRIEVE_MAX);
  const ranked: Array<{ vault: ScopedVault; hit: SemanticSectionHit }> = [];
  for (const target of resolved.vaults) {
    const hits = await provider.search(query, { kind: 'vault', vaultId: target.id }, limit);
    for (const hit of hits) {
      if (!scope.isProtected(hit.path.replace(/\\/g, '/'))) {
        ranked.push({ vault: target, hit });
      }
    }
  }
  if (ranked.length === 0) {
    return ok('No sections are similar enough to the query. Try vault_search with distinctive words, or vault_list to see what exists.');
  }
  ranked.sort((a, b) => b.hit.score - a.hit.score);
  const shown = ranked.slice(0, limit);
  return ok(
    [
      `${plural(shown.length, 'section')}, most similar first:`,
      '',
      shown
        .map(
          ({ vault, hit }) =>
            `${scope.label(vault, hit.path.replace(/\\/g, '/'), resolved.labelled)}:${hit.line} — ${hit.heading} (score ${hit.score.toFixed(2)})\n  ${clip(hit.snippet)}`,
        )
        .join('\n\n'),
    ].join('\n'),
  );
}
