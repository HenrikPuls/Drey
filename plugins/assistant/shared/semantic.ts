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

/** How much of the vault rides with one question: off / active vault / all vaults. */
export type VaultScope = 'off' | 'vault' | 'all';

/** Tolerates legacy payloads (absent or malformed → `off`). */
export function normalizeVaultScope(value: unknown): VaultScope {
  return value === 'vault' || value === 'all' ? value : 'off';
}

/** Config defaults (plugin config store keys: `semantic.*`). */
export const DEFAULT_SEMANTIC_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_SEMANTIC_TOP_K = 4;
export const DEFAULT_SEMANTIC_MIN_SCORE = 0.3;
export const MAX_SEMANTIC_TOP_K = 8;

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
  path: string;
  heading: string;
  line: number;
  score: number;
  text: string;
}

/** The persisted per-turn citation (the ```drey-context fence entry). */
export interface ContextCite {
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
    'VAULT CONTEXT — sections retrieved by similarity to the question; read-only reference, cite paths like "path:line" when you use them.',
  ];
  hits.forEach((hit, i) => {
    const text = hit.text.length > CONTEXT_MAX_CHARS
      ? `${hit.text.slice(0, CONTEXT_MAX_CHARS)}\n[…section truncated…]`
      : hit.text;
    parts.push(`[${i + 1}] ${hit.path} — ${hit.heading} (line ${hit.line})\n${text}`);
  });
  return parts.join('\n\n');
}

export function contextCitations(hits: readonly RetrievedSection[]): ContextCite[] {
  return hits.map((hit) => ({ path: hit.path, heading: hit.heading, line: hit.line }));
}

/** One compact replay line listing what an older turn retrieved (text is NOT replayed). */
export function compactContextLine(cites: readonly ContextCite[]): string {
  if (cites.length === 0) {
    return '';
  }
  const list = cites.map((cite) => `${cite.path} — ${cite.heading}`).join('; ');
  return `[Vault context used for this answer: ${list}]`;
}
