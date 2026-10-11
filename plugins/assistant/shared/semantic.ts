/**
 * Semantic vault retrieval (ADR-0055): the pure half of the feature —
 * scope type, config defaults, e5 prefixes, the fence-aware section
 * splitter, float32-vector (de)serialisation, cosine ranking inputs, and
 * the two context formatters (system-prompt block + compact replay line).
 * Main-side only at runtime; the spec suite drives it directly.
 *
 * The section splitter mirrors `plugins/tags/shared/sections.ts` (copied,
 * not imported — cross-plugin imports are banned, ADR-0044); keep the two
 * algorithms in step when one changes.
 */

/**
 * How much of the vault rides with one question: off / active vault / all
 * vaults / an explicit subset (`custom` — e.g. a non-active Git vault,
 * selected in the Vault chip's picker).
 */
export type VaultScope = 'off' | 'vault' | 'all' | 'custom';

/** Tolerates legacy payloads (absent or malformed → `off`). */
export function normalizeVaultScope(value: unknown): VaultScope {
  return value === 'vault' || value === 'all' || value === 'custom' ? value : 'off';
}

/** A scope that actually retrieves (everything but `off`). */
export type ActiveVaultScope = Exclude<VaultScope, 'off'>;

/**
 * Resolves a scope to concrete vault ids (the ask-time target list).
 * `custom` intersects the selection with the registry — ids of removed
 * vaults drop out silently; an empty result is reported by the service
 * (`noTargets`), never fallen back to the active vault.
 */
export function resolveTargetVaultIds(
  vaults: readonly { id: string; active: boolean }[],
  scope: ActiveVaultScope,
  vaultIds: readonly string[] = [],
): string[] {
  if (scope === 'all') {
    return vaults.map((v) => v.id);
  }
  if (scope === 'custom') {
    const wanted = new Set(vaultIds);
    return vaults.filter((v) => wanted.has(v.id)).map((v) => v.id);
  }
  const active = vaults.find((v) => v.active);
  return active !== undefined ? [active.id] : [];
}

/**
 * Derives the scope from a picker's checked set: none → `off`, exactly
 * the active vault → `vault`, every registered vault → `all` (so a vault
 * added later joins automatically — a static id list would not), and any
 * other subset → `custom` with the checked ids (registry order).
 */
export function deriveVaultScope(
  checked: readonly string[],
  vaults: readonly { id: string; active: boolean }[],
): { scope: VaultScope; vaultIds: string[] } {
  const known = [...new Set(checked)];
  if (known.length === 0) {
    return { scope: 'off', vaultIds: [] };
  }
  const ids = vaults.map((v) => v.id);
  if (known.length === ids.length && known.every((id) => ids.includes(id))) {
    return { scope: 'all', vaultIds: [] };
  }
  const active = vaults.find((v) => v.active);
  if (active !== undefined && known.length === 1 && known[0] === active.id) {
    return { scope: 'vault', vaultIds: [] };
  }
  return { scope: 'custom', vaultIds: ids.filter((id) => known.includes(id)) };
}

/** Config defaults (plugin config store keys: `semantic.*`). */
export const DEFAULT_SEMANTIC_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_SEMANTIC_TOP_K = 4;
export const DEFAULT_SEMANTIC_MIN_SCORE = 0.3;
export const MAX_SEMANTIC_TOP_K = 8;

/**
 * The SDK seam's hit budget (SDK 1.18): the Search panel / MCP semantic
 * mode browse results, so they get more than an ask turn's `topK` — but
 * still bounded.
 */
export const DEFAULT_SEMANTIC_SEARCH_LIMIT = 12;
export const MAX_SEMANTIC_SEARCH_LIMIT = 20;

/**
 * A hit's ~240-char preview, whitespace collapsed, from the section
 * start (semantic hits have no literal match to centre a window on).
 * Mirrors the tags search's snippet format so panels render alike.
 */
export function semanticSnippet(text: string, maxChars = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat;
}

/**
 * e5 embedding models are trained with `query:` / `passage:` prefixes;
 * without them quality drops sharply. Everything else embeds unprefixed.
 */
export function isE5Model(model: string): boolean {
  return /e5/i.test(model);
}

export function queryText(model: string, question: string): string {
  const trimmed = question.trim();
  return isE5Model(model) ? `query: ${trimmed}` : trimmed;
}

export function passageText(model: string, sectionText: string): string {
  const body = sectionText.slice(0, PASSAGE_MAX_CHARS);
  return isE5Model(model) ? `passage: ${body}` : body;
}

/** Passage cap before embedding — e5 truncates at 512 tokens anyway. */
export const PASSAGE_MAX_CHARS = 2000;

/**
 * Paths that never enter (or surface from) the semantic index. Chat notes
 * (`chats/`, mirroring `CHATS_DIR` in `shared/chat-note.ts` — kept local
 * so this module stays dependency-free) are excluded on purpose: a chat
 * about a question embeds the literal question text, so every
 * conversation self-amplifies and outranks the note that actually answers
 * the question (observed in practice — four chat turns displaced the
 * "Kaffee trinken" daily note). The conversation transcript is not vault
 * knowledge; the tags/search index still covers chats (ADR-0048).
 */
export function isSemanticIndexPath(path: string): boolean {
  return !path.startsWith('chats/');
}

/** Cap on one retrieved section's text inside the system-prompt block. */
export const CONTEXT_MAX_CHARS = 1200;

/** Batch size for the index build's embed requests (one worker round each). */
export const EMBED_BATCH = 16;

/** One heading-delimited piece of a note (the splitter's output). */
export interface SemanticSection {
  /** Heading text without the leading `#`s, or the file's base name. */
  heading: string;
  /** 1-based line the section starts on (the heading line, or line 1). */
  line: number;
  /** The section's text, heading line excluded, outer blank lines trimmed. */
  text: string;
}

export interface RawSection {
  heading: string;
  level: number;
  line: number;
  text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

/** Splits a Markdown body into heading-delimited sections, fence-aware. */
export function splitSemanticSections(body: string): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let heading = '';
  let level = 0;
  let startLine = 1;
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buf.join('\n').replace(/^\s+|\s+$/g, '');
    if (level === 0 && text === '') {
      return;
    }
    sections.push({ heading, level, line: startLine, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      flush();
      heading = match[2];
      level = match[1].length;
      startLine = i + 1;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();

  return sections;
}

/** The indexable sections of one note; empty bodies produce nothing. */
export function semanticSectionsFor(path: string, content: string): SemanticSection[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const out: SemanticSection[] = [];
  for (const section of splitSemanticSections(content)) {
    if (section.text === '') {
      continue;
    }
    out.push({
      heading: section.heading || base,
      line: section.line,
      text: section.text,
    });
  }
  return out;
}

// -- vectors -----------------------------------------------------------------

/** Float32 little-endian → base64 (index-file + spec transport form). */
export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let bits = '';
  for (const byte of bytes) {
    bits += String.fromCharCode(byte);
  }
  return btoa(bits);
}

/** Inverse of `encodeVector`; throws on a corrupted payload. */
export function decodeVector(encoded: string): Float32Array {
  const bits = atob(encoded);
  const bytes = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    bytes[i] = bits.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

/** True cosine; the embedder returns normalized vectors, so this is also the dot product. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// -- context shaping -----------------------------------------------------------

/** One retrieved section with its hydrated text (what the model reads). */
export interface RetrievedSection {
  vaultId: string;
  /** The vault's display name — citations disambiguate equal paths across vaults. */
  vault?: string;
  path: string;
  heading: string;
  line: number;
  score: number;
  text: string;
}

/**
 * One retrieval attempt's full result: not just the hits, but WHY there
 * are none — `enabled: false` means nothing was searched at all (the
 * Vault chip was on while the feature is off in Settings), `noTargets`
 * means a custom selection referenced no registered vault (removed
 * vaults), and `minScore` lets the caller report the floor an empty
 * result fell under. Retrieval failures still throw; the caller catches.
 */
export interface RetrievalOutcome {
  enabled: boolean;
  minScore: number;
  hits: RetrievedSection[];
  noTargets?: boolean;
  /**
   * The scope's resolved target vault ids (ADR-0069): the engine passes
   * them to the host as the ask's `vaultToolsScope`, so out-of-scope
   * `vault_search`/`vault_read` drop from the tool set. Absent only on
   * legacy fakes / when nothing was resolved.
   */
  targets?: readonly string[];
}

/** The persisted per-turn citation (the ```drey-context fence entry). */
export interface ContextCite {
  /** The vault's display name; absent on notes written before it existed. */
  vault?: string;
  path: string;
  heading: string;
  line: number;
}

/** The system-prompt block for one ask turn — the ONLY place section text rides. */
export function buildVaultContextBlock(hits: readonly RetrievedSection[]): string {
  if (hits.length === 0) {
    return '';
  }
  const parts: string[] = [
    'VAULT CONTEXT — sections retrieved by similarity to the question; read-only reference, cite them as vault · path:line when you use them.',
  ];
  hits.forEach((hit, i) => {
    const text = hit.text.length > CONTEXT_MAX_CHARS
      ? `${hit.text.slice(0, CONTEXT_MAX_CHARS)}\n[…section truncated…]`
      : hit.text;
    const where = hit.vault !== undefined ? `${hit.vault} · ${hit.path}` : hit.path;
    parts.push(`[${i + 1}] ${where} — ${hit.heading} (line ${hit.line})\n${text}`);
  });
  return parts.join('\n\n');
}

export function contextCitations(hits: readonly RetrievedSection[]): ContextCite[] {
  return hits.map((hit) => ({
    ...(hit.vault !== undefined ? { vault: hit.vault } : {}),
    path: hit.path,
    heading: hit.heading,
    line: hit.line,
  }));
}

/** One compact replay line listing what an older turn retrieved (text is NOT replayed). */
export function compactContextLine(cites: readonly ContextCite[]): string {
  if (cites.length === 0) {
    return '';
  }
  const list = cites
    .map((cite) => `${cite.vault !== undefined ? `${cite.vault} · ` : ''}${cite.path} — ${cite.heading}`)
    .join('; ');
  return `[Vault context used for this answer: ${list}]`;
}
