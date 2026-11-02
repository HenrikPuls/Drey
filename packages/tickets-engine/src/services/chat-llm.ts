/**
 * The Mission Control LLM bridge (E5a, ADR-0088 later change): the one
 * provider seam the chat service composes (concept §4.7 — one prompt in,
 * structured answer out). It speaks the OpenAI-compatible dialect
 * directly: POST {baseUrl}/chat/completions, `stream: true`, SSE `data:`
 * frames whose `choices.delta.content` accumulates the reply, parsed by
 * core/chat-intents after the stream completes. The system prompt is a
 * dep (the mission prompt by default, AGGREGATOR_SYSTEM_PROMPT for the
 * improvement loop's turns — E6). The bridge never touches the vault and
 * never throws: a missing model, an unreachable provider and an
 * unreadable answer each resolve an honest envelope whose say explains
 * the situation and whose commands stay empty.
 */
import type { ChatBridge, ChatCommand, ChatStreamEvent } from '../contracts/chat';
import { parseEnvelope } from '../core/chat-intents';

/** The config keys the bridge reads from the engine's config store. */
const KEY_BASE_URL = 'chat.baseUrl';
const KEY_API_KEY = 'chat.apiKey';
const KEY_MODEL = 'chat.model';
/** One mission turn may take this long before the bridge gives up — honestly. */
const TURN_TIMEOUT_MS = 120_000;

/**
 * The system prompt of every mission turn (English, per the owner
 * decision 2026-11-02). The run embeds the board digest below it; the
 * STRICT output contract is what makes the accumulated reply parseable
 * by core/chat-intents.
 */
export const MISSION_SYSTEM_PROMPT = `You are Mission Control, the owner's single operational contact for the tickets board.

You serve exactly six intents:
- steer — the owner wants a ticket moved or reprioritised: answer with a short say plus a transition and/or setPriority command.
- create — the owner captures an idea or an inbox item: answer with a createTicket command for the phase the owner names (inbox when none is named).
- promote — the owner accepts a scout ticket's report and wants the ticket built: answer with a promote command naming that ticket; it turns into a ship ticket and enters the normal pipeline (plan, worktree, gate) on its next run.
- chain — the owner wants a ticket's gate chain changed (insert a gate, skip a gate, set a notify rule, or return the ticket to the standard flow): answer with a setChain command carrying the ticket's whole new delta, never a partial edit.
- blocked — the owner wants a ticket to wait for others (or stop waiting): answer with a setBlockedBy command carrying the ticket's whole blocker list, never a partial edit.
- report — the owner asks about the board: answer from the board digest alone and propose no commands.

STRICT output contract: your entire reply is exactly one JSON object and nothing outside it — no prose before or after, no markdown fences:
{"say": string, "thought": string, "commands": []}
- "say" is the sentence you speak to the owner.
- "thought" is your brief reasoning.
- "commands" holds zero or more typed commands, each safe to propose: the chat NEVER writes without the owner's explicit confirmation — every command renders as a proposal card the owner confirms or dismisses.

Rules:
- Never invent ticket ids: use only ids that appear in the board digest below.
- Never invent priority words: the board's priorities are configured per vault — the digest's "priorities (weight order)" line is the whole vocabulary, and a setPriority/createTicket command picks from it.
- description fields are written in the owner's language.
- Propose only what the board itself does: createTicket, transition, setPriority, promote, setChain, setBlockedBy.
- setChain replaces the ticket's whole chain delta with the given list — one canonical entry per item: "insert <phase>[(<persona>[, notify] | notify)] after|before <anchor>" adds a gate at the anchor phase (a phase the standard flow already contains may be revisited this way, at most once), "skip <phase>" bypasses a gate for this ticket, "notify <phase>" lands a card in Needs you when the gate completes. An empty list returns the ticket to the standard flow. Phase ids are the digest's column ids. Example: {"kind":"setChain","id":"T-0086","chain":["insert design(pia, notify) after review","skip verify"]}.
- setBlockedBy replaces the ticket's whole blocked-by list with the given ticket ids (digest ids only) — the ticket waits until every one reaches the terminal column. An empty list clears the blockers. Example: {"kind":"setBlockedBy","id":"T-0002","blockedBy":["T-0001","T-0003"]}.`;

/**
 * The system prompt of an improvement turn (E6, concept §4.8): the
 * aggregator reads one persona's friction log plus a short run history
 * and answers with improvement drafts. Same wire, same STRICT contract
 * style as the mission prompt — the reply parses as one JSON array.
 */
export const AGGREGATOR_SYSTEM_PROMPT = `You are the improvement aggregator for one tickets persona.

You read the persona's friction log — one line per thing that went wrong on a ticket — plus a short run history, and you propose concrete improvements as STRICTLY one JSON array and nothing outside it — no prose before or after, no markdown fences:
[{"target":"prompt.md|models.default|memory","title":"…","evidence":["<friction lines used>"],"content":"<replacement text / model id / lesson line>","lesson":"<optional short lesson>"}]
- "target" names what the draft changes: the persona's prompt.md, its models.default, or its memory.md.
- "title" is one short sentence naming the improvement.
- "evidence" quotes the friction lines the draft rests on — only lines from the input.
- "content" is the complete replacement: the full new prompt text, the model id, or the one-line memory lesson. It drops into the file as written.
- "lesson" is optional — a short lesson worth remembering once the draft is applied.

Rules:
- Propose at most 3 drafts; merge duplicate findings into one proposal.
- Every draft is backed by evidence from the input — never invent friction.
- Content must be concrete and complete, never a summary.`;

/** The config access the bridge needs — the engine's FileConfigStore fits. */
export interface ChatLlmConfig {
  get<T>(key: string): Promise<T | undefined>;
}

export interface ChatBridgeDeps {
  readonly config: ChatLlmConfig;
  /** The transport; the global fetch by default (the specs inject a fake). */
  readonly fetch?: typeof fetch;
  /** The clock; the turn-timeout check reads it, so a spec can simulate a stall. */
  readonly now?: () => number;
  /** The system prompt of every turn; MISSION_SYSTEM_PROMPT by default (the aggregator passes its own). */
  readonly systemPrompt?: string;
}

/** The mission's answer — or its honest explanation of why there is none. */
interface TurnOutcome {
  readonly say: string;
  readonly thought: string | null;
  readonly commands: readonly ChatCommand[];
}

export function createChatBridge(deps: ChatBridgeDeps): ChatBridge {
  const transport = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const systemPrompt = deps.systemPrompt ?? MISSION_SYSTEM_PROMPT;

  return {
    async runTurn(input) {
      const emit = (event: ChatStreamEvent): void => input.emit(event);
      /** The honest fallback: one explaining text event, no commands, never a throw. */
      const fail = (say: string): TurnOutcome => {
        emit({ kind: 'text', text: say });
        return { say, thought: null, commands: [] };
      };

      const [baseUrl, apiKey, model] = await Promise.all([
        deps.config.get<string>(KEY_BASE_URL),
        deps.config.get<string>(KEY_API_KEY),
        deps.config.get<string>(KEY_MODEL),
      ]);
      const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
      const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;
      const modelId = typeof model === 'string' ? model.trim() : '';
      if (base === '' || modelId === '') {
        return fail('Mission Control is not set up yet — pick the assistant model in Settings, then ask again.');
      }

      const controller = new AbortController();
      const startedAt = now();
      const watchdog = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
      watchdog.unref?.();
      try {
        const response = await transport(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key === null ? {} : { authorization: `Bearer ${key}` }),
          },
          body: JSON.stringify({
            model: modelId,
            stream: true,
            messages: [
              { role: 'system', content: `${systemPrompt}\n\n## Board digest\n\n${input.board}` },
              ...input.history.map((message) => ({
                role: message.role === 'owner' ? 'user' : 'assistant',
                content: message.text,
              })),
              { role: 'user', content: input.text },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return fail(`The chat model answered ${response.status} — Mission Control cannot reach it right now.`);
        }
        if (response.body === null) {
          return fail('The chat model returned no stream — Mission Control cannot reach it right now.');
        }

        const reply = await readSse(
          response.body as unknown as AsyncIterable<Uint8Array>,
          (delta) => emit({ kind: 'text', text: delta }),
          () => {
            if (now() - startedAt > TURN_TIMEOUT_MS) {
              controller.abort();
              return 'The chat model took too long to answer — try again.';
            }
            return null;
          },
        );
        if (reply.timedOut !== null) {
          return fail(reply.timedOut);
        }
        const envelope = parseEnvelope(reply.text, input.priorities);
        if (envelope === null) {
          return fail("The chat model's reply could not be read — it answered outside its envelope.");
        }
        return { say: envelope.say, thought: envelope.thought, commands: envelope.commands };
      } catch (error) {
        if (controller.signal.aborted) {
          return fail('The chat model took too long to answer — try again.');
        }
        const message = error instanceof Error ? error.message : String(error);
        return fail(`The chat model could not be reached (${message}) — Mission Control is sorry.`);
      } finally {
        clearTimeout(watchdog);
      }
    },
  };
}

/**
 * Walks one SSE body: blank-line frames, `data:` lines, `[DONE]` ignored.
 * Every content delta reaches `onDelta` as it arrives (the UI's live
 * text); the full accumulated reply returns for the envelope parse. The
 * `onChunk` check folds a never-ending stream into the turn timeout.
 */
async function readSse(
  body: AsyncIterable<Uint8Array>,
  onDelta: (delta: string) => void,
  onChunk: () => string | null,
): Promise<{ readonly text: string; readonly timedOut: string | null }> {
  let text = '';
  let buffer = '';
  let timedOut: string | null = null;
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    timedOut = onChunk();
    if (timedOut !== null) {
      break;
    }
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data === '' || data === '[DONE]') {
        continue;
      }
      const delta = deltaContent(data);
      if (delta !== null && delta !== '') {
        text += delta;
        onDelta(delta);
      }
    }
  }
  return { text, timedOut };
}

/** The `choices[0].delta.content` string of one streamed chunk, null when absent. */
function deltaContent(data: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const choices = (raw as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return null;
  }
  const delta = (first as Record<string, unknown>)['delta'];
  if (typeof delta !== 'object' || delta === null) {
    return null;
  }
  const content = (delta as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}
