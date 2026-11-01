import { parseDocument } from 'yaml';
import { splitFrontmatter } from '../../../../shared/frontmatter';

/**
 * Personas (ADR-0088, E3 — the concept's §4): a named agent is role +
 * behaviour + model + memory in one, stored as a directory per persona in
 * the tickets repo:
 *
 *   tickets/_meta/personas/
 *     pia/
 *       persona.md   # frontmatter: title, role, worker, models, color, skills
 *       prompt.md    # the persona prompt (longform, editable, versioned)
 *       memory.md    # curated memory (the write/read paths are E3)
 *       avatar.png   # optional
 *
 * The resolution ladder collapses the old five-level assignment ring
 * (ticket pin > column > handover > repo > default) into three:
 *
 *   Ticket-Pin (`persona:` im Frontmatter)
 *     → Phasen-Persona (`persona:` in pipeline.md)
 *       → Default-Persona (engine config `personas.default`)
 *
 * A persona's `models.default` + `models.pool` replace the separate
 * `worker:`/`model:`/`prompt:` keys — the model is configuration, not
 * identity (concept §4.6). The old column keys stay readable while the
 * migration rewrites them onto personas, then they are deprecated.
 */

export type PersonaRole = 'planner' | 'builder' | 'reviewer' | 'tester' | 'custom';

export const PERSONA_ROLES: readonly PersonaRole[] = ['planner', 'builder', 'reviewer', 'tester', 'custom'];

export type PersonaRouter = 'off' | 'budget' | 'escalate-on-fail';

export interface PersonaModels {
  /** What runs when nothing else decides. */
  readonly default: string;
  /** Allowed models, order = fallback on rate-limits/outages. */
  readonly pool: readonly string[];
  /** Optional routing policy inside the pool; default off (deterministic). */
  readonly router: PersonaRouter;
}

export interface Persona {
  /** The directory id (the folder name under `_meta/personas/`). */
  readonly id: string;
  readonly title: string;
  readonly role: PersonaRole;
  /** The CLI harness (`claude-code` | `opencode` | `api`). */
  readonly worker: string;
  readonly models: PersonaModels;
  /** UI color (`#rrggbb`), chips and avatars. */
  readonly color: string;
  /** Reusable skill files under `_meta/skills/` this persona carries. */
  readonly skills: readonly string[];
}

export const PERSONAS_DIR = 'tickets/_meta/personas';

export function personaRef(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error(`a persona id is lowercase letters, digits and dashes — got "${id}"`);
  }
  return id;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

/** Parse one persona file; tolerant like the ticket reader — what parses
 *  reads, the rest falls back to defaults and is reported by the caller's
 *  own validation if it cares. */
export function parsePersonaFile(id: string, text: string): Persona {
  personaRef(id);
  const { yamlText, hadFence } = splitFrontmatter(text);
  const js = hadFence && yamlText !== null ? (parseDocument(yamlText).toJS() as Record<string, unknown> | null) : null;
  const get = (key: string): unknown => (js === null || typeof js !== 'object' ? undefined : js[key]);

  const title = asString(get('title')) ?? id;
  const roleRaw = asString(get('role')) ?? 'custom';
  const role = (PERSONA_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as PersonaRole) : 'custom';
  const worker = asString(get('worker')) ?? 'opencode';

  const modelsMap = (get('models') ?? {}) as Record<string, unknown>;
  const defaultModel = asString(modelsMap['default']) ?? 'opus';
  const poolRaw = asStringList(modelsMap['pool']);
  const pool = poolRaw.length > 0 ? poolRaw : [defaultModel];
  const routerRaw = asString(modelsMap['router']) ?? 'off';
  const router = (['off', 'budget', 'escalate-on-fail'] as const).includes(routerRaw as PersonaRouter)
    ? (routerRaw as PersonaRouter)
    : 'off';

  const color = asString(get('color')) ?? '#a78bfa';
  const skills = asStringList(get('skills'));

  return { id, title, role, worker, models: { default: defaultModel, pool, router }, color, skills };
}

/** The canonical persona file text (stable key order, byte-stable round trips). */
export function personaFileText(persona: Persona): string {
  personaRef(persona.id);
  const lines = [
    '---',
    `title: ${persona.title}`,
    `role: ${persona.role}`,
    `worker: ${persona.worker}`,
    'models:',
    `  default: ${persona.models.default}`,
    `  pool: [${persona.models.pool.join(', ')}]`,
    `  router: ${persona.models.router}`,
    `color: '${persona.color}'`,
    `skills: [${persona.skills.join(', ')}]`,
    '---',
    '',
    `Who ${persona.title} is: role, tone, limits. Edit freely — the next run reads it.`,
    '',
  ];
  return lines.join('\n');
}

/**
 * THE ladder (concept §4.2): ticket pin > phase persona > engine default.
 * Returns the winning persona id and which level decided — the Verlauf
 * and the cost attribution need the provenance as much as the id.
 */
export interface PersonaResolution {
  readonly persona: string | null;
  readonly source: 'ticket' | 'phase' | 'default' | 'none';
}

export function resolvePersona(input: {
  readonly ticketPersona: string | null;
  readonly phasePersona: string | null;
  readonly defaultPersona: string | null;
}): PersonaResolution {
  if (input.ticketPersona !== null && input.ticketPersona.trim() !== '') {
    return { persona: input.ticketPersona.trim(), source: 'ticket' };
  }
  if (input.phasePersona !== null && input.phasePersona.trim() !== '') {
    return { persona: input.phasePersona.trim(), source: 'phase' };
  }
  if (input.defaultPersona !== null && input.defaultPersona.trim() !== '') {
    return { persona: input.defaultPersona.trim(), source: 'default' };
  }
  return { persona: null, source: 'none' };
}

/**
 * The model a persona actually runs on a dispatch: the router only picks
 * INSIDE the pool (concept §4.6) — deterministic without one.
 */
export function personaModelFor(persona: Persona, contextTokens: number | null): { model: string; viaRouter: boolean } {
  if (persona.models.router === 'off' || contextTokens === null) {
    return { model: persona.models.default, viaRouter: false };
  }
  // `budget`: the cheapest pool model that carries the context. Without a
  // price table the pool order IS the price order (owner-curated), so the
  // first entry wins; `escalate-on-fail` also starts at the default and
  // climbs inside the pool on failure — the runner records what ran.
  return { model: persona.models.pool[0] ?? persona.models.default, viaRouter: true };
}

/**
 * The migration reader (concept §4.2): one pipeline column's legacy
 * `worker:`/`model:`/`prompt:` keys become a persona candidate. The
 * caller (the dispatcher) persists the generated personas and rewrites
 * the pipeline; this function stays pure.
 */
export interface PersonaMigration {
  /** The suggested persona id (the prompt ref, slugified, deduped by the caller). */
  readonly id: string;
  readonly title: string;
  readonly worker: string;
  readonly model: string | null;
  /** The prompt file content: the column's `prompt:` ref content lives in _meta/prompts. */
  readonly promptRef: string | null;
}

export function personaMigrationFor(input: {
  readonly phaseId: string;
  readonly worker: string | null;
  readonly model: string | null;
  readonly prompt: string | null;
}): PersonaMigration | null {
  if (input.worker === null && input.model === null && input.prompt === null) {
    return null;
  }
  const id = input.prompt?.trim() !== '' && input.prompt !== null
    ? input.prompt!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    : `${input.phaseId}-default`;
  return {
    id: id === '' ? `${input.phaseId}-default` : id,
    title: id.replace(/-/g, ' '),
    worker: input.worker ?? 'opencode',
    model: input.model ?? null,
    promptRef: input.prompt,
  };
}
