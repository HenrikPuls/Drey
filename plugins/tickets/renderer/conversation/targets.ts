/**
 * The tickets plugin's conversation targets for the Assistant (E13-5, SDK
 * 1.41): **Mission Control** (the engine's chat, Pia; the plugin IPC `mc*`
 * forwards to `ChatService`) and **1:1** with each persona of the team
 * (the merged persona conversation of E12-4: the owner's messages to that
 * persona). The Assistant knows none of this -- it draws whatever
 * `conversations.registerTargets` is handed.
 */
import type {
  ConversationTarget,
  ConversationTargetProvider,
  ConversationThread,
} from '../../../../shared/plugin-api/renderer';
import type {
  ChatDecisionResult,
  ChatSession,
  ChatSessionMeta,
  ChatTurnResult,
} from '../../../../packages/tickets-engine/src/contracts/chat';
import type { PersonaView } from '../../shared/remote-protocol';
import {
  EMPTY_THREAD,
  errorMessageOf,
  historyOfSessions,
  threadOfPersona,
  threadOfSession,
} from './map';

/** The id a view preset names as its `assistantTarget` (the Work view: Mission Control). */
export const MISSION_CONTROL_TARGET = 'tickets.mission-control';

/** The switcher segment the persona targets share. */
export const PERSONA_GROUP = '1:1';

export const personaTargetId = (personaId: string): string => `tickets.persona.${personaId}`;

export interface ConversationDeps {
  /** The plugin IPC (`api.backend.invoke`). */
  invoke(method: string, payload?: unknown): Promise<unknown>;
  /** The team directory (the Team tab's store). */
  personas(): readonly PersonaView[];
  /** Fires when the directory changed; returns the unsubscribe. */
  subscribePersonas(listener: () => void): () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Pia: the engine's chat sessions. */
export function createMissionControlTarget(deps: ConversationDeps): ConversationTarget {
  let file: string | null = null;
  /** A failed turn is not part of the session file; it hangs on the thread until the next send. */
  let lastError: ReturnType<typeof errorMessageOf> | null = null;

  const open = async (path: string): Promise<ConversationThread> => {
    try {
      const session = (await deps.invoke('mcOpen', { file: path })) as ChatSession | null;
      if (session === null || typeof session !== 'object' || !('messages' in session)) {
        file = null;
        return EMPTY_THREAD;
      }
      file = session.file;
      return withError(threadOfSession(session));
    } catch (error) {
      return { ...EMPTY_THREAD, messages: [errorMessageOf(undefined, messageOf(error))] };
    }
  };

  const withError = (thread: ConversationThread): ConversationThread =>
    lastError === null ? thread : { ...thread, messages: [...thread.messages, lastError] };

  const reopen = async (): Promise<ConversationThread> => (file === null ? withError(EMPTY_THREAD) : open(file));

  return {
    id: MISSION_CONTROL_TARGET,
    label: 'Mission Control',
    description: 'Talk to Mission Control: it knows the board and proposes changes you confirm',
    thread: async () => {
      if (file === null) {
        try {
          const sessions = (await deps.invoke('mcSessions')) as readonly ChatSessionMeta[];
          const newest = Array.isArray(sessions) ? sessions[0] : undefined;
          if (newest !== undefined) {
            return open(newest.file);
          }
        } catch (error) {
          return { ...EMPTY_THREAD, messages: [errorMessageOf(undefined, messageOf(error))] };
        }
        return EMPTY_THREAD;
      }
      return reopen();
    },
    send: async (text) => {
      lastError = null;
      let result: ChatTurnResult;
      try {
        result = (await (file === null
          ? deps.invoke('mcStart', { text })
          : deps.invoke('mcSend', { file, text }))) as ChatTurnResult;
      } catch (error) {
        lastError = errorMessageOf(undefined, messageOf(error));
        return reopen();
      }
      if (typeof result.file === 'string') {
        file = result.file;
      }
      if (result.ok !== true) {
        lastError = errorMessageOf(result.failure, result.error);
      }
      return reopen();
    },
    act: async (cardId, actionId) => {
      lastError = null;
      if (file === null) {
        return EMPTY_THREAD;
      }
      try {
        let result: { ok?: boolean; error?: string };
        if (cardId.startsWith('s-')) {
          result = (await deps.invoke('mcShapeDecide', { file, choice: actionId })) as { ok?: boolean; error?: string };
        } else {
          result = (await deps.invoke('mcDecide', { file, id: cardId, decision: actionId })) as ChatDecisionResult;
        }
        if (result.ok !== true) {
          lastError = errorMessageOf(undefined, result.error);
        }
      } catch (error) {
        lastError = errorMessageOf(undefined, messageOf(error));
      }
      return reopen();
    },
    newThread: async () => {
      file = null;
      lastError = null;
      return EMPTY_THREAD;
    },
    history: async () => {
      try {
        const sessions = (await deps.invoke('mcSessions')) as readonly ChatSessionMeta[];
        return Array.isArray(sessions) ? historyOfSessions(sessions) : [];
      } catch {
        return [];
      }
    },
    open: async (id) => {
      lastError = null;
      return open(id);
    },
  };
}

/** A 1:1 with one persona: the owner's messages in that persona's thread. */
export function createPersonaTarget(deps: ConversationDeps, persona: PersonaView): ConversationTarget {
  const read = async (): Promise<ConversationThread> => {
    try {
      return threadOfPersona(persona.id, persona.title, await deps.invoke('personaThread', { persona: persona.id }));
    } catch (error) {
      return threadOfPersona(persona.id, persona.title, { ok: false, error: messageOf(error) });
    }
  };
  return {
    id: personaTargetId(persona.id),
    label: persona.title,
    group: PERSONA_GROUP,
    description: `Talk to ${persona.title} 1:1`,
    thread: read,
    send: async (text) => {
      try {
        return threadOfPersona(
          persona.id,
          persona.title,
          await deps.invoke('personaThreadAppend', { persona: persona.id, text }),
        );
      } catch (error) {
        return threadOfPersona(persona.id, persona.title, { ok: false, error: messageOf(error) });
      }
    },
    act: read,
    newThread: read,
  };
}

/** The provider the plugin registers: Mission Control first, then one 1:1 per agent persona. */
export function createConversationProvider(deps: ConversationDeps): ConversationTargetProvider {
  const mission = createMissionControlTarget(deps);
  const personaTargets = new Map<string, ConversationTarget>();
  return {
    targets: () => {
      const targets: ConversationTarget[] = [mission];
      const live = new Set<string>();
      for (const persona of deps.personas()) {
        // The owner as a team member has no thread worth opening.
        if (persona.kind === 'human') {
          continue;
        }
        live.add(persona.id);
        const known = personaTargets.get(persona.id);
        const target = known !== undefined && known.label === persona.title ? known : createPersonaTarget(deps, persona);
        personaTargets.set(persona.id, target);
        targets.push(target);
      }
      for (const id of [...personaTargets.keys()]) {
        if (!live.has(id)) {
          personaTargets.delete(id);
        }
      }
      return targets;
    },
    onChange: (listener) => deps.subscribePersonas(listener),
  };
}
