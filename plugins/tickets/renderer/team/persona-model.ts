// i18n: catalog
/**
 * The Persona page's pure model (board 7k, milestone 201): the tab's key,
 * the persona's files, what the form edits and which keys a Save sends
 * (`personaPatch` writes only the sent keys, one commit). DOM-free, so the
 * page and the spec share it.
 */
import type { PersonaView } from '../../shared/remote-protocol';
import type { PipelinePhase } from '../../shared/tickets';
import { poolLabelOf, roleLabel } from './team-model';

export const PERSONA_KIND = 'tickets-persona';

const PERSONA_KEY_SCHEME = 'persona://';

export function personaKeyOf(id: string): string {
  return `${PERSONA_KEY_SCHEME}${id}`;
}

/** The persona id of a tab's key; '' for any other key. */
export function personaIdOfKey(key: string): string {
  return key.startsWith(PERSONA_KEY_SCHEME) ? key.slice(PERSONA_KEY_SCHEME.length) : '';
}

/** The persona's files in the vault, in full (read, opened) and as the page writes them. */
export function personaPathsOf(id: string): { readonly persona: string; readonly prompt: string; readonly personaShort: string; readonly promptShort: string; readonly dirShort: string } {
  return {
    persona: `tickets/_meta/personas/${id}/persona.md`,
    prompt: `tickets/_meta/personas/${id}/prompt.md`,
    personaShort: `personas/${id}/persona.md`,
    promptShort: `personas/${id}/prompt.md`,
    dirShort: `personas/${id}/`,
  };
}

/** What the form edits; the role as the field shows it (`Builder`). */
export interface PersonaDraft {
  readonly title: string;
  readonly role: string;
  readonly prompt: string;
  readonly pool: readonly string[];
  readonly skills: readonly string[];
}

/** The keys a Save sends. */
export interface PersonaPatchKeys {
  title?: string;
  role?: string;
  prompt?: string;
  pool?: readonly string[];
  skills?: readonly string[];
}

export function draftOf(view: PersonaView, prompt: string, skills: readonly string[]): PersonaDraft {
  return {
    title: view.title,
    role: roleLabel(view.role),
    prompt,
    pool: view.pool.length > 0 ? view.pool : view.model === '' ? [] : [view.model],
    skills,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Only what differs from the record: the engine writes the sent keys and one commit. The role goes as the engine's word. */
export function patchOf(base: PersonaDraft, draft: PersonaDraft): PersonaPatchKeys {
  const patch: PersonaPatchKeys = {};
  if (draft.title.trim() !== base.title.trim()) {
    patch.title = draft.title.trim();
  }
  const role = draft.role.trim().toLowerCase();
  if (role !== base.role.trim().toLowerCase()) {
    patch.role = role;
  }
  if (draft.prompt !== base.prompt) {
    patch.prompt = draft.prompt;
  }
  if (!sameList(draft.pool, base.pool)) {
    patch.pool = draft.pool;
  }
  if (!sameList(draft.skills, base.skills)) {
    patch.skills = draft.skills;
  }
  return patch;
}

export function isDirty(base: PersonaDraft, draft: PersonaDraft): boolean {
  return Object.keys(patchOf(base, draft)).length > 0;
}

/** One step chip: what the persona works, read from the pipeline's `persona:` keys. */
export interface StepChip {
  readonly id: string;
  readonly title: string;
  readonly on: boolean;
}

/** The agent steps of the flow, and any other step this persona is pinned on. A human step is never offered: Accept is always the owner's. */
export function stepsOf(pipeline: readonly PipelinePhase[], phases: readonly string[]): readonly StepChip[] {
  return pipeline
    .filter((phase) => phase.handover.startsWith('agent') || phases.includes(phase.id))
    .map((phase) => ({ id: phase.id, title: phase.title, on: phases.includes(phase.id) }));
}

/** One row of the model pool. */
export interface PoolRow {
  readonly index: number;
  readonly label: string;
  readonly model: string;
  /** The row's overflow line; false for the first choice. */
  readonly overflow: boolean;
}

/** The persona has one worker: every row names it, the order is the fallback order. */
export function poolRowsOf(worker: string, pool: readonly string[]): readonly PoolRow[] {
  const label = poolLabelOf(worker);
  return pool.map((model, index) => ({ index: index + 1, label, model, overflow: index > 0 }));
}

/** A skill's file name as a row's name: `go-conventions` -> `Go conventions`. */
export function skillTitleOf(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words === '' ? id : words[0]!.toUpperCase() + words.slice(1);
}

/** The instructions' length as the status bar shows it. */
export function wordsOf(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** A failed read that only means the file is not there yet (a persona without a prompt.md). */
export function isMissingFileError(error: unknown): boolean {
  return /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error));
}
