import { parseDocument } from 'yaml';
import { splitFrontmatter } from '../../../../shared/frontmatter';
import { isWorkerProvider } from '../fleet/protocol';

/**
 * Personas (ADR-0088, E3 — the concept's §4): a named agent is role +
 * behaviour + model + memory in one, stored as a directory per persona in
 * the tickets repo:
 *
 *   tickets/_meta/personas/
 *     paul/
 *       persona.md   # frontmatter: title, role, worker, models, color, skills, budget
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

/**
 * What a persona is (E10-6): an `agent` (the fleet runs it) or the `human`
 * — the owner as a team member. A gate assigned to the human persona
 * parks the ticket instead of dispatching a run; the human never counts
 * toward capacity, budget or the worker pool.
 */
export type PersonaKind = 'agent' | 'human';

export const PERSONA_KINDS: readonly PersonaKind[] = ['agent', 'human'];

/** The directory id of the owner's own persona (`personas/you`). */
export const HUMAN_PERSONA_ID = 'you';

export interface Persona {
  /** The directory id (the folder name under `_meta/personas/`). */
  readonly id: string;
  /** `agent` (default, absent in the file) or `human` (E10-6). */
  readonly kind: PersonaKind;
  readonly title: string;
  readonly role: PersonaRole;
  /** The CLI harness (`claude-code` | `opencode` | `kimi` | `api`). */
  readonly worker: string;
  readonly models: PersonaModels;
  /** UI color (`#rrggbb`), chips and avatars. */
  readonly color: string;
  /** Skill files this persona carries, by name; {@link loadPersonaSkills} says where a name is looked for. */
  readonly skills: readonly string[];
  /**
   * The persona's daily budget in USD (`budget:`, concept §4.3 — the
   * Team view shows the day's costs against it); null = no budget set.
   */
  readonly budget: number | null;
}

export const PERSONAS_DIR = 'tickets/_meta/personas';

/**
 * Personas in pipeline order (fidelity ruling O12): `PERSONA_ROLES` is the crew's
 * order, plan to test, then custom ones, and the human last; within a role by id.
 * The role decides because the stock pipeline names no persona per step of Building.
 */
export function inPipelineOrder<P extends Pick<Persona, 'id' | 'role' | 'kind'>>(personas: readonly P[]): P[] {
  const rank = (persona: P): number => (persona.kind === 'human' ? PERSONA_ROLES.length : PERSONA_ROLES.indexOf(persona.role));
  return [...personas].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

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
  const kind: PersonaKind = asString(get('kind')) === 'human' ? 'human' : 'agent';
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

  // `budget:` is USD per day; tolerant — absent, non-numeric or negative reads as null.
  const budgetRaw = get('budget');
  const budgetNum = typeof budgetRaw === 'number' ? budgetRaw : typeof budgetRaw === 'string' ? Number(budgetRaw.trim()) : Number.NaN;
  const budget = Number.isFinite(budgetNum) && budgetNum >= 0 ? budgetNum : null;

  return { id, kind, title, role, worker, models: { default: defaultModel, pool, router }, color, skills, budget };
}

/** True for the owner's own persona (E10-6) — no run, no model, no budget. */
export function isHumanPersona(persona: Pick<Persona, 'kind'> | null | undefined): boolean {
  return persona?.kind === 'human';
}

/** A fresh human persona: the owner as a team member; the model fields are inert placeholders. */
export function humanPersona(title: string, id: string = HUMAN_PERSONA_ID): Persona {
  return {
    id,
    kind: 'human',
    title,
    role: 'custom',
    worker: 'opencode',
    models: { default: 'opus', pool: ['opus'], router: 'off' },
    color: '#38bdf8',
    skills: [],
    budget: null,
  };
}

/** The canonical persona file text (stable key order, byte-stable round trips).
 *  `body` is the owner's prose below the fence ("Who Paul is, tone, limits",
 *  concept §4.1); a patch passes the existing file's body through, a fresh
 *  persona gets the default line. */
export function personaFileText(persona: Persona, body?: string): string {
  personaRef(persona.id);
  const prose =
    body !== undefined && body.trim() !== ''
      ? body.trimStart()
      : persona.kind === 'human'
        ? `${persona.title} is you: manual steps park the ticket here until you accept or send it back.`
        : `Who ${persona.title} is: role, tone, limits. Edit freely — the next run reads it.`;
  const lines = [
    '---',
    `title: ${persona.title}`,
    ...(persona.kind === 'human' ? ['kind: human'] : []),
    `role: ${persona.role}`,
    `worker: ${persona.worker}`,
    'models:',
    `  default: ${persona.models.default}`,
    `  pool: [${persona.models.pool.join(', ')}]`,
    `  router: ${persona.models.router}`,
    `color: '${persona.color}'`,
    `skills: [${persona.skills.join(', ')}]`,
    ...(persona.budget !== null ? [`budget: ${persona.budget}`] : []),
    '---',
    '',
    prose,
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
 * What a dispatch knows when it picks a persona's model (D-62): the
 * phase, the persona's own harness provider, the free slots of every
 * provider pool at this point of the pass (`fleet.pool.<provider>.size`
 * minus the live runs, as the planner counts them), and how many runs of
 * this ticket failed in this phase in a row (the escalation ladder).
 */
export interface PersonaModelContext {
  readonly phase: string;
  /** The persona's worker provider — a pool entry without a provider prefix runs there. */
  readonly provider: string;
  /** Free slots per provider right now; a provider not listed is taken as free. */
  readonly freeSlots: Readonly<Partial<Record<string, number>>>;
  /** Consecutive failed runs of the ticket in this phase (0 on a first run). */
  readonly failedRuns: number;
}

export interface PersonaModelChoice {
  readonly model: string;
  /** The provider the chosen pool entry names (`kimi/k2`); null = the persona's own worker. */
  readonly provider: string | null;
  readonly viaRouter: boolean;
  /** Why this model — one short clause for runner.log. */
  readonly reason: string;
}

/**
 * A pool entry is `<model>` or `<provider>/<model>` with one of the fleet's
 * worker providers (the worker value grammar of `fleet/assignment.ts`); a
 * slash after anything else is part of the model id (`zai/glm-5.3`).
 */
export function splitPoolEntry(entry: string): { readonly provider: string | null; readonly model: string } {
  const text = entry.trim();
  const slashAt = text.indexOf('/');
  if (slashAt > 0 && isWorkerProvider(text.slice(0, slashAt)) && text.slice(slashAt + 1) !== '') {
    return { provider: text.slice(0, slashAt), model: text.slice(slashAt + 1) };
  }
  return { provider: null, model: text };
}

/**
 * The model a persona actually runs on a dispatch (D-62): the pool is the
 * fallback order, the router the policy inside it (concept §4.6).
 *
 * - router `off`: the default first, then the pool in order;
 * - `budget`: the pool in order (the owner curates it cheapest first);
 * - `escalate-on-fail`: the default, then one pool step further per
 *   failed run of the ticket in this phase (the pool's end holds).
 *
 * An entry whose provider pool has no free slot is skipped; when every
 * entry is full the first one is named and the provider gate makes the
 * ticket wait, as before. Without a context (the Crew tab, an estimate)
 * the default stands. req-170 replaces this with a class request against
 * the model table and a capacity cap — never a smaller class.
 */
export function personaModelFor(persona: Persona, context: PersonaModelContext | null): PersonaModelChoice {
  const fallback: PersonaModelChoice = { model: persona.models.default, provider: null, viaRouter: false, reason: 'the default' };
  if (context === null) {
    return fallback;
  }
  const entries = persona.models.pool.map(splitPoolEntry);
  const router = persona.models.router;
  const defaultEntry = { provider: null, model: persona.models.default };
  const defaultAt = entries.findIndex((e) => e.provider === null && e.model === persona.models.default);
  // The order the dispatch walks: budget = the pool as curated; off = the
  // default, then the rest of the pool; escalate = the default, then the
  // pool entries after it (the ones before it are the cheaper ones).
  const order =
    router === 'budget'
      ? entries
      : router === 'escalate-on-fail'
        ? [defaultEntry, ...(defaultAt === -1 ? entries : entries.slice(defaultAt + 1))]
        : [defaultEntry, ...entries.filter((_, i) => i !== defaultAt)];
  if (order.length === 0) {
    return fallback;
  }
  const step = router === 'escalate-on-fail' ? Math.min(context.failedRuns, order.length - 1) : 0;
  const candidates = order.slice(step);
  const policy =
    router === 'escalate-on-fail' && step > 0
      ? `escalate-on-fail: step ${step} after ${context.failedRuns} failed run${context.failedRuns === 1 ? '' : 's'} in ${context.phase}`
      : router === 'budget'
        ? 'budget router: the pool in order'
        : router === 'escalate-on-fail'
          ? 'escalate-on-fail: the default on a first run'
          : 'the default';
  const free = (provider: string | null): number => context.freeSlots[provider ?? context.provider] ?? Number.POSITIVE_INFINITY;
  const skipped: string[] = [];
  for (const entry of candidates) {
    if (free(entry.provider) > 0) {
      const because = skipped.length > 0 ? `${skipped.join(', ')} — pool fallback` : policy;
      return { model: entry.model, provider: entry.provider, viaRouter: router !== 'off', reason: because };
    }
    skipped.push(`${entry.model}: the ${entry.provider ?? context.provider} pool is full`);
  }
  const first = candidates[0]!;
  return { model: first.model, provider: first.provider, viaRouter: router !== 'off', reason: 'every pool entry is full — the ticket waits' };
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

/** One skill as a run's brief carries it (D-46). */
export interface PersonaSkill {
  readonly name: string;
  readonly text: string;
}

/**
 * The texts of the skills a persona's record names (D-46): the persona's own
 * `skills/` folder first, then the crew's shared `_meta/skills/`; a name is a
 * file `<name>.md` or a folder with `SKILL.md`. A name with no readable text,
 * or one that would leave those folders, is reported, never guessed.
 */
export async function loadPersonaSkills(
  read: (rel: string) => Promise<string | null>,
  personaId: string,
  names: readonly string[],
): Promise<{ readonly skills: readonly PersonaSkill[]; readonly missing: readonly string[] }> {
  const skills: PersonaSkill[] = [];
  const missing: string[] = [];
  for (const name of names) {
    let text: string | null = null;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      for (const base of [`${PERSONAS_DIR}/${personaId}/skills`, 'tickets/_meta/skills']) {
        for (const rel of [`${base}/${name}.md`, `${base}/${name}/SKILL.md`]) {
          text ??= await read(rel).catch(() => null);
        }
      }
    }
    if (text === null || text.trim() === '') {
      missing.push(name);
    } else {
      skills.push({ name, text: text.trim() });
    }
  }
  return { skills, missing };
}
