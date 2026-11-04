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
import type { ChatBridge, ChatCommand, ChatShapeReply, ChatStreamEvent } from '../contracts/chat';
import { parseEnvelope, type ChatEnvelope } from '../core/chat-intents';

/** The config keys the bridge reads from the engine's config store. */
const KEY_BASE_URL = 'chat.baseUrl';
const KEY_API_KEY = 'chat.apiKey';
const KEY_MODEL = 'chat.model';
/** One mission turn may take this long before the bridge gives up — honestly. */
const TURN_TIMEOUT_MS = 120_000;
/** A shape turn may read the repository this many times before it must answer. */
const MAX_READ_ROUNDS = 3;

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
- setChain replaces the ticket's whole chain delta with the given list — one canonical entry per item: "insert <phase>[(<persona>[, notify] | notify)] after|before <anchor>" adds a gate at the anchor phase (a phase the standard flow already contains may be revisited this way, at most once), "skip <phase>" bypasses a gate for this ticket, "notify <phase>" lands a card in Needs you when the gate completes. An empty list returns the ticket to the standard flow. Phase ids are the digest's column ids. Example: {"kind":"setChain","id":"T-0086","chain":["insert security(ralf, notify) after review","skip verify"]}.
- setBlockedBy replaces the ticket's whole blocked-by list with the given ticket ids (digest ids only) — the ticket waits until every one reaches the terminal column. An empty list clears the blockers. Example: {"kind":"setBlockedBy","id":"T-0002","blockedBy":["T-0001","T-0003"]}.`;

/**
 * The system prompt of a shape turn (E10-3, concept v2 §5.8). Paul shapes
 * one ticket with the owner; Mission Control relays him. The contract
 * extends the mission envelope — the plan chapter is the one thing he
 * may write, the repository he only reads.
 */
export const SHAPE_SYSTEM_PROMPT = `You are Paul, the planner of the tickets crew. The owner shapes one new ticket with you; Mission Control relays your words, so you speak to the owner directly and briefly.

You work on exactly one thing: the ticket's "## Plan" chapter below. You may read the ticket's repository (read-only) and you write nothing but the plan.

STRICT output contract: your entire reply is exactly one JSON object and nothing outside it — no prose before or after, no markdown fences:
{"say": string, "thought": string, "plan": string, "question": {"text": string, "options": [{"label": string, "recommended": boolean}]}, "split": {"reason": string}, "read": [string]}
Every field except "say" is optional:
- "say" is what you tell the owner: what you changed, what you decided, what you need.
- "thought" is your brief reasoning.
- "plan" is the COMPLETE new body of the Plan chapter (without the "## Plan" heading); leave it out when the plan stays as it is. Use these chapters in this order: "### Goal", "### Architecture" (a mermaid block, only when components or flows change), "### Parts", "### Acceptance criteria", "### Open questions". Never write a "## " heading.
- "### Parts" lists the steps in execution order, one "- [ ] <title>" each, with indented detail lines "persona: <id>" (ben builds, ralf reviews, tessa tests, paul plans), "reason: <one line>" and optionally "chain: <entries>". One part means no Parts chapter at all. How many parts there are follows the plan — never pad, never force a number.
- "question" asks the owner one thing with 2 to 4 short choices; mark at most one "recommended". The owner picks a choice and sends it, or answers in their own words. Ask only what you cannot decide from the repository.
- "split" says you are ready to settle: the owner then sees "Keep as one ticket" or "Split into N tickets" (N is counted from your Parts). "reason" is one sentence why — the parts ship and test on their own, or the plan has a single part.
- "read" lists repository paths you want to read before you answer (a trailing "/" lists a directory). You get their contents in the next message; answer only when you have read enough. At most 6 paths per request.

Rules:
- The owner may edit the plan between your turns; a message starting "The owner edited the plan" shows exactly what changed — never undo it, build on it.
- Keep what the owner wrote. Rewrite only what the conversation changed.
- Never invent files or facts about the repository: read, or say you do not know.
- Reply in the owner's language.`;

/**
 * The system prompt of a flow draft (E10-5, concept v2 §5.7). Paul reads
 * one flow and proposes the whole chain delta; the envelope is the
 * mission envelope with a single setChain command, which the desk
 * validates and shows as a draft — nothing is written by the draft.
 */
export const FLOW_SYSTEM_PROMPT = `You are Paul, the planner of the tickets crew. The owner asks you to draft the flow (the chain of gates) of one ticket or one part of a plan. You only propose; the owner sees your draft, edits it and saves it or drops it.

STRICT output contract: your entire reply is exactly one JSON object and nothing outside it — no prose before or after, no markdown fences:
{"say": string, "thought": string, "commands": [{"kind": "setChain", "id": string, "chain": [string]}]}
- "say" is one or two sentences: why the flow looks like this. It is shown to the owner next to the draft.
- The single command's "id" is the ticket id given below; "chain" is the WHOLE delta against the standard flow, one canonical entry per item. An empty list means the standard flow stays as it is.

The grammar, one entry per item:
- "insert <phase>[(<persona>[, notify] | notify)] after|before <anchor>" adds a gate (a phase of the standard flow may be added once more, as a revisit). Example: "insert security(ralf, notify) after review".
- "skip <phase>" strikes a standard gate for this flow.
- "notify <phase>" tells the owner when a standard gate is done.
- "move <phase> after|before <anchor>" runs a standard gate somewhere else.
- "assign <phase> <persona>" pins who works a standard gate.

Rules:
- Start from the standard flow and change as little as the task needs; most flows need no change or one.
- Use only phase ids and persona ids that appear in the context below. Never touch a gate marked locked or one that has begun.
- The crew: paul plans, ben builds, ralf reviews, tessa tests — pick by the personas listed.
- Reply in the owner's language.`;

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
  readonly shape?: ChatShapeReply;
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
        const shape = input.shape;
        const sources: string[] = [];
        const system =
          input.flow !== undefined
            ? `${FLOW_SYSTEM_PROMPT}\n\n## Flow\n\n${input.flow.context}`
            : shape === undefined
              ? `${systemPrompt}\n\n## Board digest\n\n${input.board}`
              : `${SHAPE_SYSTEM_PROMPT}\n\n## Ticket ${shape.ticket}\n\n${shape.ticketText}`;
        const messages: { role: string; content: string }[] = [
          { role: 'system', content: system },
          ...input.history.map((message) => ({
            role: message.role === 'owner' ? 'user' : 'assistant',
            content: message.text,
          })),
          { role: 'user', content: input.planDelta === undefined ? input.text : `${input.planDelta}\n\n${input.text}` },
        ];
        let envelope: ChatEnvelope | null = null;
        for (let round = 0; ; round++) {
          const response = await transport(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(key === null ? {} : { authorization: `Bearer ${key}` }),
            },
            body: JSON.stringify({ model: modelId, stream: true, messages }),
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
            // A shape reply is one JSON envelope around the plan: showing it
            // as it types would print the document escaped. The screen waits
            // (and shows what Paul reads) until the finished turn is read back.
            (delta) => (shape === undefined ? emit({ kind: 'text', text: delta }) : undefined),
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
          envelope = parseEnvelope(reply.text, input.priorities);
          if (envelope === null) {
            return fail("The chat model's reply could not be read — it answered outside its envelope.");
          }
          // A shape turn may read the repository before it answers: the
          // files go back as the next user message, a bounded few rounds.
          if (shape === undefined || (envelope.read ?? []).length === 0 || round >= MAX_READ_ROUNDS) {
            break;
          }
          emit({ kind: 'thought', text: `Reading ${(envelope.read ?? []).join(', ')}. ` });
          const chunks: string[] = [];
          for (const path of envelope.read ?? []) {
            const file = await shape.readFile(path);
            if (file.ok) {
              if (!sources.includes(path)) {
                sources.push(path);
              }
              chunks.push(`### ${path}\n${file.text}`);
            } else {
              chunks.push(`### ${path}\nError: ${file.error}`);
            }
          }
          messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: `Files you asked for:\n\n${chunks.join('\n\n')}` });
        }
        const out: TurnOutcome = { say: envelope.say, thought: envelope.thought, commands: envelope.commands };
        if (shape === undefined) {
          return out;
        }
        const shaped: ChatShapeReply = { plan: envelope.plan ?? null, question: envelope.question ?? null, splitReason: envelope.splitReason ?? null, sources };
        return { ...out, shape: shaped };
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
