/**
 * The tool loop both HTTP providers run (ADR-0071): ask the model, run
 * the tools it calls, feed the results back, until it answers in text.
 * A provider supplies one function that performs a single request in its
 * own dialect; everything a model can get wrong is handled here, once:
 *
 * - only a tool that was offered runs; an unknown name, broken or
 *   mistyped arguments and a tool that throws all come back to the model
 *   as an `Error: …` result it can act on — none of them fails the call;
 * - a result is capped, with a hint how to narrow the call;
 * - a reply cut off by the output limit never runs its (half-written)
 *   calls;
 * - a call written into the reply text instead of the native field is
 *   read (`parseTextToolCalls`);
 * - when the round budget is used up the model gets one closing round
 *   that asks for the answer without tools, instead of an empty reply;
 * - an endpoint that refuses the very first request with tools attached
 *   is retried without them, and the result says so;
 * - the loop owns delta forwarding: a provider that streams a round
 *   forwards its text through the `emit` it was handed, and the loop
 *   delivers a non-streamed final round's text as exactly one `onDelta`
 *   call — no provider can double-deliver.
 */
import {
  ChatMessage,
  ChatToolCall,
  LlmChatResult,
  LlmUsage,
  ToolSpec,
  checkToolArgs,
  parseTextToolCalls,
} from '../../shared/llm';
import type { LlmChatOptions } from './llm-client';
import { LlmError } from './llm-errors';
import { cancelledError, isAbortError, isSignalAborted } from './llm-tasks';

/** Round budget when the caller names none. */
export const DEFAULT_TOOL_ROUNDS = 12;

/** A tool result longer than this is cut; the tools' own limits sit below it. */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/**
 * How a request treats the tools: `tools` offers them, `closing` still
 * declares them (a transcript holding tool calls needs the declarations)
 * but forbids a call, `plain` sends none.
 */
export type ToolMode = 'tools' | 'closing' | 'plain';

/** One model reply, in the canonical shape. */
export interface ModelReply {
  text: string;
  toolCalls: ChatToolCall[];
  /** The reply stopped at the output limit. */
  truncated: boolean;
  usage?: LlmUsage;
}

/**
 * One request in the provider's dialect. `first` is true until a tool has
 * run: only then may the provider answer `'tools-rejected'` (the endpoint
 * refused the request because of the tools) instead of throwing.
 * `emit` forwards one text delta of this round as it streams in; a
 * non-streamed round never calls it, and the loop — not the provider —
 * decides what still reaches the caller's `onDelta`.
 */
export type RequestRound = (
  convo: readonly ChatMessage[],
  mode: ToolMode,
  first: boolean,
  emit: (delta: string) => void,
) => Promise<ModelReply | 'tools-rejected'>;

const CLOSING_NOTE =
  'The tool budget for this question is used up. Do not call any more tools. Answer now from what you have found so far, and say plainly what you could not check.';

const CUT_OFF_ERROR =
  'Error: your reply was cut off by the output limit before this call was complete, so nothing was run — call the tool again with shorter arguments (several smaller edits instead of one large one).';

/**
 * A tool call as an OpenAI-compatible server sent it, in the canonical
 * shape. Local servers are loose here: the id can be missing and the
 * arguments can arrive as an object instead of a JSON string.
 */
export function toChatToolCall(raw: unknown, index: number): ChatToolCall {
  const call = (raw !== null && typeof raw === 'object' ? raw : {}) as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const args = call.function?.arguments;
  return {
    id: typeof call.id === 'string' && call.id !== '' ? call.id : `call-${index}`,
    type: 'function',
    function: {
      name: typeof call.function?.name === 'string' ? call.function.name : '',
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  };
}

function capResult(result: string): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) {
    return result;
  }
  return `${result.slice(0, TOOL_RESULT_MAX_CHARS)}\n[… cut after ${TOOL_RESULT_MAX_CHARS} of ${result.length} characters — narrow the call (a smaller range, a more specific query) to see the rest]`;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function addUsage(total: LlmUsage, usage: LlmUsage | undefined): void {
  if (usage?.inputTokens !== undefined) {
    total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
  }
  if (usage?.outputTokens !== undefined) {
    total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
  }
}

/** Runs one call the model asked for; always resolves to the text the model gets back. */
async function runCall(
  call: ChatToolCall,
  specs: ReadonlyMap<string, ToolSpec>,
  options: LlmChatOptions,
): Promise<string> {
  // A cancel that arrived while another call of the round ran: this
  // queued call never starts, and the ask rejects like the one before it.
  if (isSignalAborted(options.signal)) {
    throw cancelledError();
  }
  const name = call.function.name;
  const spec = specs.get(name);
  if (spec === undefined) {
    return `Error: there is no tool "${name}" — the tools you can call are: ${[...specs.keys()].join(', ')}.`;
  }
  const checked = checkToolArgs(spec, call.function.arguments);
  if (!checked.ok) {
    return checked.error;
  }
  const argsJson = JSON.stringify(checked.args);
  options.onToolEvent?.({ phase: 'start', id: call.id, name, argsJson });
  let result: string;
  try {
    result = capResult(await options.onToolCall!(name, argsJson, options.signal));
  } catch (err) {
    if (isAbortError(err) || isSignalAborted(options.signal)) {
      throw err;
    }
    result = `Error: ${name} failed — ${err instanceof Error ? err.message : String(err)}`;
  }
  options.onToolEvent?.({
    phase: 'end',
    id: call.id,
    name,
    argsJson,
    ok: !result.startsWith('Error:'),
  });
  return result;
}

export async function runToolLoop(
  messages: readonly ChatMessage[],
  options: LlmChatOptions,
  request: RequestRound,
): Promise<LlmChatResult> {
  const specs = new Map((options.tools ?? []).map((spec) => [spec.name, spec]));
  const offered = new Set(specs.keys());
  const maxRounds = options.maxToolRounds ?? DEFAULT_TOOL_ROUNDS;
  const convo: ChatMessage[] = [...messages];
  const toolTrace: ChatMessage[] = [];
  const usage: LlmUsage = {};
  let mode: ToolMode = specs.size > 0 && options.onToolCall !== undefined ? 'tools' : 'plain';
  let toolsDropped = false;
  let budgetExhausted = false;
  let rounds = 0;
  // Whether the round in flight has already streamed its text through
  // `emit` — the final round decides what `finish` forwards.
  let roundEmitted = false;
  const emit = (delta: string): void => {
    if (delta === '') {
      return;
    }
    roundEmitted = true;
    options.onDelta?.(delta);
  };

  const finish = (text: string): LlmChatResult => {
    // A final round that streamed has already delivered its text delta
    // by delta; a non-streamed one forwards the whole text exactly once,
    // so a caller never branches on capability to render the reply.
    if (text !== '' && !roundEmitted) {
      options.onDelta?.(text);
    }
    return {
      text,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
      ...(toolsDropped ? { toolsDropped } : {}),
      ...(budgetExhausted ? { toolBudgetExhausted: budgetExhausted } : {}),
    };
  };
  const close = (): void => {
    convo.push({ role: 'user', content: CLOSING_NOTE });
    mode = 'closing';
  };

  for (;;) {
    roundEmitted = false;
    const reply = await request(convo, mode, toolTrace.length === 0, emit);
    if (reply === 'tools-rejected') {
      mode = 'plain';
      toolsDropped = true;
      continue;
    }
    addUsage(usage, reply.usage);

    let { text, toolCalls } = reply;
    if (mode === 'tools' && toolCalls.length === 0 && text !== '') {
      const written = parseTextToolCalls(text, offered);
      if (written !== null) {
        ({ text } = written);
        toolCalls = written.calls;
      }
    }

    if (mode === 'tools' && toolCalls.length > 0) {
      if (rounds >= maxRounds) {
        budgetExhausted = true;
        close();
        continue;
      }
      rounds++;
      // A call whose arguments are not JSON goes back into the transcript
      // as `{}`: an endpoint may refuse a transcript it cannot parse.
      const assistantTurn: ChatMessage = {
        role: 'assistant',
        content: text !== '' ? text : null,
        tool_calls: toolCalls.map((call) =>
          isValidJson(call.function.arguments)
            ? call
            : { ...call, function: { ...call.function, arguments: '{}' } },
        ),
      };
      convo.push(assistantTurn);
      toolTrace.push(assistantTurn);
      for (const call of toolCalls) {
        const result = reply.truncated ? CUT_OFF_ERROR : await runCall(call, specs, options);
        const toolTurn: ChatMessage = { role: 'tool', tool_call_id: call.id, content: result };
        convo.push(toolTurn);
        toolTrace.push(toolTurn);
      }
      continue;
    }

    if (text !== '') {
      return finish(text);
    }
    if (mode === 'tools' && toolTrace.length > 0) {
      // Tools ran but the model said nothing: ask once for the answer.
      close();
      continue;
    }
    if (toolTrace.length > 0) {
      return finish('');
    }
    // Silent-empty is how "no response" looked to the user — surface it.
    throw new LlmError('bad-reply', 'The endpoint returned no message content.');
  }
}
