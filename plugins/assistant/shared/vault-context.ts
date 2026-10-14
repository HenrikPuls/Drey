/**
 * The Vault chip's context (ADR-0072): the pure half — the scope type,
 * the question-to-terms split, the ranking of text-search hits, and the
 * two context formatters (system-prompt block + compact replay line).
 * Main-side only at runtime; the spec suite drives it directly.
 *
 * The sections come from the tags plugin's section index, searched by
 * the words of the question. There is no index of its own here and no
 * embedding model (the retrieval of ADR-0055 was removed).
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

/** A scope that actually reaches into the vault (everything but `off`). */
export type ActiveVaultScope = Exclude<VaultScope, 'off'>;

/**
 * Resolves a scope to concrete vault ids (the ask-time target list).
 * `custom` intersects the selection with the registry — ids of removed
 * vaults drop out silently; an empty result is reported by the caller
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

/** How many sections ride one question. */
export const VAULT_CONTEXT_TOP_K = 4;

/** Cap on one section's text inside the system-prompt block. */
export const CONTEXT_MAX_CHARS = 1200;

/** How many words of a question are searched for. */
export const MAX_QUERY_TERMS = 8;

/**
 * Paths that never ride as vault context. Chat notes (`chats/`, mirroring
 * `CHATS_DIR` in `shared/chat-note.ts` — kept local so this module imports
 * no other plugin code) are excluded on purpose: a chat about a question
 * contains the literal question text, so every conversation would outrank
 * the note that actually answers it. The transcript is not vault
 * knowledge; the Search panel still covers chats (ADR-0048).
 */
export function isVaultContextPath(path: string): boolean {
  return !path.startsWith('chats/');
}

// -- the question's words ------------------------------------------------------

/**
 * Words that say nothing about a note's topic (German and English: the
 * question words, articles, pronouns, auxiliaries). Kept small — a word
 * that is missing here only costs a low-weight term.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // German
  'aber', 'alle', 'als', 'also', 'auch', 'auf', 'aus', 'bei', 'bin', 'bis', 'bitte', 'das',
  'dass', 'dem', 'den', 'denn', 'der', 'des', 'die', 'dies', 'diese', 'diesem', 'diesen',
  'dieser', 'dieses', 'doch', 'dort', 'durch', 'ein', 'eine', 'einem', 'einen', 'einer',
  'eines', 'etwas', 'für', 'gab', 'gibt', 'habe', 'haben', 'hat', 'hatte', 'hier', 'ich',
  'ihr', 'ihre', 'ist', 'kann', 'kannst', 'mal', 'man', 'mein', 'meine', 'meinem', 'meinen',
  'meiner', 'mich', 'mir', 'mit', 'nach', 'nicht', 'noch', 'nur', 'oder', 'sein', 'seine',
  'sich', 'sie', 'sind', 'über', 'und', 'uns', 'unser', 'unsere', 'vom', 'von', 'vor',
  'wann', 'war', 'waren', 'warum', 'was', 'weiß', 'welche', 'welchem', 'welchen', 'welcher',
  'welches', 'wenn', 'wer', 'wie', 'wieso', 'wir', 'wird', 'wo', 'wurde', 'wurden', 'zu',
  'zum', 'zur',
  // English
  'about', 'all', 'and', 'any', 'are', 'but', 'can', 'did', 'does', 'for', 'from', 'had',
  'has', 'have', 'how', 'into', 'its', 'know', 'mine', 'not', 'our', 'out', 'she', 'that',
  'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'was', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/**
 * The words of a question worth searching for: lower-cased, split at
 * anything that is not a letter or a digit, without stopwords and words
 * under three characters, each once, at most {@link MAX_QUERY_TERMS}.
 */
export function queryTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word) || out.includes(word)) {
      continue;
    }
    out.push(word);
    if (out.length === MAX_QUERY_TERMS) {
      break;
    }
  }
  return out;
}

// -- ranking -------------------------------------------------------------------

/** One section a term was found in (what the section index returns). */
export interface LexicalHit {
  vaultId: string;
  path: string;
  heading: string;
  line: number;
  text: string;
}

/** Every section one term was found in. */
export interface TermHits {
  term: string;
  hits: readonly LexicalHit[];
}

/**
 * Ranks the sections the question's words were found in, best first. A
 * section scores the sum of the weights of the words it contains; a word
 * found in few sections weighs more than one found in many
 * (`1 / ln(2 + sections)`), and a word in the heading counts one and a
 * half times. Ties keep vault, path and line order, so the result is
 * stable.
 */
export function rankLexical(perTerm: readonly TermHits[], limit: number): LexicalHit[] {
  const scored = new Map<string, { hit: LexicalHit; score: number }>();
  for (const { term, hits } of perTerm) {
    if (hits.length === 0) {
      continue;
    }
    const weight = 1 / Math.log(2 + hits.length);
    for (const hit of hits) {
      const key = `${hit.vaultId}\n${hit.path}\n${hit.line}`;
      const entry = scored.get(key) ?? { hit, score: 0 };
      entry.score += hit.heading.toLowerCase().includes(term) ? weight * 1.5 : weight;
      scored.set(key, entry);
    }
  }
  return [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.hit.vaultId.localeCompare(b.hit.vaultId) ||
        a.hit.path.localeCompare(b.hit.path) ||
        a.hit.line - b.hit.line,
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.hit);
}

// -- context shaping -----------------------------------------------------------

/** One section that rides the question, with its text (what the model reads). */
export interface RetrievedSection {
  vaultId: string;
  /** The vault's display name — citations disambiguate equal paths across vaults. */
  vault?: string;
  path: string;
  heading: string;
  line: number;
  text: string;
}

/**
 * One lookup's full result: not just the hits, but WHY there are none —
 * `unavailable` means no section index answered (the Tags plugin is
 * disabled), `noTargets` means a custom selection referenced no
 * registered vault (removed vaults). Failures still throw; the caller
 * catches.
 */
export interface RetrievalOutcome {
  hits: RetrievedSection[];
  unavailable?: boolean;
  noTargets?: boolean;
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
    'VAULT CONTEXT — note sections that contain words of the question; read-only reference, cite them as vault · path:line when you use them.',
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

/** One compact replay line listing what an older turn was given (text is NOT replayed). */
export function compactContextLine(cites: readonly ContextCite[]): string {
  if (cites.length === 0) {
    return '';
  }
  const list = cites
    .map((cite) => `${cite.vault !== undefined ? `${cite.vault} · ` : ''}${cite.path} — ${cite.heading}`)
    .join('; ');
  return `[Vault context used for this answer: ${list}]`;
}
