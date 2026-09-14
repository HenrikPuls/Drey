/**
 * YAML frontmatter engine for note files (milestone 6). Pure string in,
 * pure string out -- no filesystem, no Electron. Lives in `shared/` so the
 * main process (which runs it inside `note:save`) and the renderer test
 * suite can both reach it; only `electron/note-manager.ts` calls it at
 * runtime.
 *
 * Built on the `yaml` package's `parseDocument()` so an edit to `tags` /
 * `updated:` is a targeted node mutation -- every other key, its value
 * style, and any comment survive the round-trip untouched. Date fields are
 * forced to double-quoted scalars per `specs/frontmatter-schema.md` (some
 * YAML consumers coerce bare dates to Date objects).
 */
import { Document, isScalar, parseDocument, Scalar, YAMLSeq } from 'yaml';
import { Frontmatter, MasterArt, NoteType } from './ipc-api';
import { formatDate, formatDateTime } from './timestamp';

/**
 * Opening `---\n`, the YAML block, the closing `---` line, then the rest.
 * Anchored at offset 0 (no `m` flag) -- a `---` further down is a
 * horizontal rule, same rule as `stripFrontmatter` in the editor service.
 */
const FENCE = /^---\n([\s\S]*?)\n(---[ \t]*(?:\n|$))([\s\S]*)$/;

const NOTE_TYPES = ['master', 'notiz', 'interview-template'] as const;
const MASTER_ARTS = ['thema', 'person', 'team', 'projekt', 'begriff'] as const;

export interface SplitResult {
  /** YAML text between the fences (no `---` lines, no trailing newline). `null` when there is no fence. */
  yamlText: string | null;
  /** Everything after the closing fence line, verbatim. The whole input when there is no fence. */
  body: string;
  hadFence: boolean;
}

/** Splits a note into its frontmatter YAML and its body without parsing either. */
export function splitFrontmatter(text: string): SplitResult {
  const match = FENCE.exec(text);
  if (!match) {
    return { yamlText: null, body: text, hadFence: false };
  }
  return { yamlText: match[1], body: match[3], hadFence: true };
}

/**
 * Parses a note's frontmatter into the normalised `Frontmatter` shape:
 * arrays always present (empty when missing/malformed), scalars `null`
 * when absent or the wrong type. Returns `null` only when the file has no
 * frontmatter fence at all, or its YAML does not parse -- callers treat
 * both as "leave this file alone".
 */
export function readFrontmatter(text: string): Frontmatter | null {
  const { yamlText, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return null;
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return null;
  }
  const parsed = doc.toJS() as unknown;
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return {
    type: asEnum(obj['type'], NOTE_TYPES),
    kind: asText(obj['kind']),
    title: asText(obj['title']),
    tags: asStringArray(obj['tags']),
    aliases: asStringArray(obj['aliases']),
    created: asText(obj['created']),
    updated: asText(obj['updated']),
    art: asEnum(obj['art'], MASTER_ARTS),
    description: asText(obj['description']),
    verweis: asText(obj['verweis']),
  };
}

/**
 * Rewrites only the keys named in `patch` and returns the full note text.
 * `tags` / `aliases` become double-quoted flow sequences
 * (`["a", "b"]`); date/text fields become double-quoted scalars;
 * `type` / `art` / `kind` stay plain. A file with no frontmatter fence, or
 * unparseable YAML, is returned unchanged.
 */
export function writeFrontmatter(text: string, patch: Partial<Frontmatter>): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return text;
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return text;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'tags' || key === 'aliases') {
      setStringSeq(doc, key, value as string[]);
    } else if (value === null) {
      if (doc.has(key)) {
        doc.set(key, null);
      }
    } else if (key === 'type' || key === 'art' || key === 'kind') {
      setScalar(doc, key, String(value), false);
    } else {
      setScalar(doc, key, String(value), true);
    }
  }

  // `flowCollectionPadding: false` -> `["a", "b"]` not `[ "a", "b" ]`
  // (matches specs/frontmatter-schema.md); `lineWidth: 0` keeps a long
  // `description:` on one line.
  let yamlOut = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!yamlOut.endsWith('\n')) {
    yamlOut += '\n';
  }
  return `---\n${yamlOut}---\n${body}`;
}

/**
 * The `updated:` value for a save (always now) and the `created:` value to
 * use (the existing one, or now as a full datetime if the file has none —
 * schema change: new files timestamp `created`, legacy date-only values in
 * existing files are kept verbatim). `now` is injectable for tests, same
 * pattern as `newDailyEntryEdit` / `applyPlaceholders`.
 */
export function bumpUpdated(
  frontmatter: Frontmatter | null,
  now: Date = new Date(),
): { updated: string; created: string } {
  const existingCreated = frontmatter?.created;
  return {
    updated: formatDateTime(now),
    created:
      existingCreated && existingCreated.trim() !== '' ? existingCreated : formatDateTime(now),
  };
}

function setScalar(doc: Document, key: string, value: string, quoted: boolean): void {
  const node = doc.get(key, true);
  if (isScalar(node)) {
    node.value = value;
    node.type = quoted ? Scalar.QUOTE_DOUBLE : Scalar.PLAIN;
    return;
  }
  const scalar = doc.createNode(value) as Scalar;
  if (quoted) {
    scalar.type = Scalar.QUOTE_DOUBLE;
  }
  doc.set(key, scalar);
}

function setStringSeq(doc: Document, key: string, values: readonly string[]): void {
  const seq = doc.createNode([...values]) as YAMLSeq;
  seq.flow = true;
  for (const item of seq.items) {
    if (isScalar(item)) {
      item.type = Scalar.QUOTE_DOUBLE;
    }
  }
  doc.set(key, seq);
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }
  if (value instanceof Date) {
    return formatDateTime(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return [value];
  }
  return [];
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}
