import { parsePersonaFile, resolvePersona, personaModelFor, type Persona, type PersonaResolution } from '../core/persona';

/**
 * The persona loader (ADR-0088, E3): the services read personas from the
 * tickets vault through one seam, so both the dispatcher (orchestrator)
 * and the manual start (board service) resolve them identically. Pure IO
 * shape: a vault-relative text reader is all it needs.
 */

export interface PersonaLoader {
  /** The parsed persona, or null when the directory/file is absent or unreadable. */
  load(id: string): Promise<Persona | null>;
  /** The persona's prompt file text; null when missing. */
  prompt(id: string): Promise<string | null>;
  /** The curated memory file text; '' when absent. */
  memory(id: string): Promise<string>;
}

export function personaLoader(read: (rel: string) => Promise<string>): PersonaLoader {
  const safe = async (rel: string): Promise<string | null> => {
    try {
      return await read(rel);
    } catch {
      return null;
    }
  };
  return {
    load: async (id) => {
      const text = await safe(`tickets/_meta/personas/${id}/persona.md`);
      return text === null ? null : parsePersonaFile(id, text);
    },
    prompt: (id) => safe(`tickets/_meta/personas/${id}/prompt.md`),
    memory: async (id) => (await safe(`tickets/_meta/personas/${id}/memory.md`)) ?? '',
  };
}

export interface ResolvedPersona {
  readonly persona: Persona | null;
  readonly resolution: PersonaResolution;
}

/** The ladder plus the load: null persona when nothing resolves or the file is gone. */
export async function resolvePersonaForTicket(
  loader: PersonaLoader,
  input: {
    readonly ticketPersona: string | null;
    readonly phasePersona: string | null;
    readonly defaultPersona: string | null;
  },
): Promise<ResolvedPersona> {
  const resolution = resolvePersona(input);
  if (resolution.persona === null) {
    return { persona: null, resolution };
  }
  const persona = await loader.load(resolution.persona);
  return { persona, resolution };
}

/**
 * What a dispatch derives from a persona: the worker harness and the
 * model (pool+router applied). The result feeds the existing
 * `composeRunRequest` — the persona is configuration, not identity.
 */
export function deriveWorkerModel(persona: Persona, contextTokens: number | null): { workerChoice: string; model: string | null } {
  const { model } = personaModelFor(persona, contextTokens);
  return { workerChoice: persona.worker, model };
}
