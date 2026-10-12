/**
 * The one vocabulary placeholder every LLM prompt shares
 * (specs/classifier-spec.md): `{{AVAILABLE_TAGS}}` is swapped for the
 * vault's tag list (one tag per line) at call time. The legacy `{tags}`
 * spelling — Autotag's original token — is still substituted, so a
 * stored, user-edited prompt from before the alignment keeps working.
 *
 * Dependency-light on purpose (like `actions.ts`): both the base
 * `TagSuggester` and the assistant plugin's action engine import it.
 */

export const VOCABULARY_TOKEN = '{{AVAILABLE_TAGS}}';

/** Autotag's original token, kept working for stored edited prompts. */
export const LEGACY_VOCABULARY_TOKEN = '{tags}';

/**
 * Replaces the vocabulary token(s) in a prompt. `task` is reserved
 * (ADR-0033) and never offered as a tag; an empty vocabulary substitutes
 * `(none yet)` so the model is not left staring at an empty block.
 */
export function substituteVocabulary(prompt: string, vocabulary: readonly string[]): string {
  const list = vocabulary.filter((tag) => tag !== 'task');
  const text = list.length > 0 ? list.join('\n') : '(none yet)';
  return prompt.replaceAll(VOCABULARY_TOKEN, text).replaceAll(LEGACY_VOCABULARY_TOKEN, text);
}
