/**
 * The `kimi` worker adapter (E10-8, docs/design/kimi-worker.md): Moonshot's
 * Kimi Code CLI driven over ACP — `kimi acp`, newline-delimited JSON-RPC 2.0
 * on stdio, pinned against kimi 2.4.1. Print mode (`kimi -p`) is not used:
 * it auto-approves everything and reports no usage.
 *
 * What ACP gives the runner: live tool calls and thoughts, approval and
 * question requests the adapter can hold open for the owner, `session/cancel`
 * (soft stop), `session/load` (resume) and `/compact`. What it does not give:
 * tokens and cost — those are read from the session's own wire log
 * (`<home>/sessions/<workspace>/<session>/agents/main/wire.jsonl`, the
 * `usage.record` lines) after each turn, and the cost is computed from the
 * editorial price table.
 */
import { costOf } from '../core/model-prices';
import { parseShapedQuestion } from '../contracts/question-shape';
import type { RunnerProcess, SpawnFn } from './procs';
import {
  activityLine,
  blockedOf,
  editChanges,
  permissionText,
  questionOf,
  RESULT_PREFIX,
  THINK_MAX,
  THINK_PREFIX,
  toolActivity,
  type NormalizedEvent,
  type NowFn,
  type ProviderAdapter,
  type ProviderStart,
} from './providers';
import type { PermissionDecision, QuestionAnswers, RunUsage, WaitQuestion } from './protocol';

/** One model call of the session, as Kimi's wire log records it. */
export interface KimiUsageRecord {
  readonly model: string | null;
  readonly inputOther: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/** Reads the session's usage records in order; empty when the log is unreadable. */
export type KimiUsageReader = (sessionRef: string) => Promise<readonly KimiUsageRecord[]>;

/** The ACP permission option a decision maps to (by `kind`, then by id). */
function optionFor(
  options: ReadonlyArray<{ readonly optionId?: string; readonly kind?: string }>,
  decision: PermissionDecision,
): string | null {
  const kind = decision === 'once' ? 'allow_once' : decision === 'always' ? 'allow_always' : 'reject_once';
  const byKind = options.find((o) => o.kind === kind);
  if (byKind?.optionId !== undefined) {
    return byKind.optionId;
  }
  const byId = options.find((o) => o.optionId === (decision === 'once' ? 'approve_once' : decision === 'always' ? 'approve_always' : 'reject'));
  return byId?.optionId ?? null;
}

interface PendingRequest {
  readonly rpcId: number | string;
  readonly kind: 'permission' | 'question';
  readonly options: ReadonlyArray<{ readonly optionId?: string; readonly name?: string; readonly kind?: string }>;
}

interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function kimiAdapter(
  spawnFn: SpawnFn,
  readUsage: KimiUsageReader = async () => [],
  now: NowFn = (): Date => new Date(),
): ProviderAdapter {
  return {
    id: 'kimi',
    label: 'Kimi Code',
    liveInject: true,
    spawn(start) {
      const iso = (): string => now().toISOString();
      const emit = (event: Omit<NormalizedEvent, 'ts'>): void => start.onEvent({ ts: iso(), ...event });
      const proc: RunnerProcess = spawnFn('kimi', ['acp'], { cwd: start.cwd });

      let buffer = '';
      let nextId = 1;
      const calls = new Map<number | string, { resolve: (m: RpcMessage) => void }>();
      let sessionId: string | null = null;
      let replaying = false;
      let busy = false;
      let held = false;
      let ended = false;
      let questionHold = false;
      /** An owner's free-text reply to a question that offers choices only: sent as the next turn. */
      let followUp: string | null = null;
      /** The turn was cancelled to make room for a steer message. */
      let steerAfterCancel: string | null = null;
      let turnText = '';
      let turnToolNames = new Map<string, string>();
      let usageSeen = 0;
      let totalIn = 0;
      let totalOut = 0;
      let totalCacheRead = 0;
      let totalCost: number | null = null;
      let model: string | null = start.model;
      let initDone = false;
      const toolArgs = new Map<string, Record<string, unknown>>();
      const pending = new Map<string, PendingRequest>();

      const send = (message: Record<string, unknown>): void => {
        proc.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      };
      const call = (method: string, params: Record<string, unknown>): Promise<RpcMessage> =>
        new Promise((resolve) => {
          const id = nextId++;
          calls.set(id, { resolve });
          send({ id, method, params });
        });
      const resultOf = (reply: RpcMessage): Record<string, unknown> => {
        if (reply.error !== undefined) {
          throw new Error(reply.error.message ?? `error ${reply.error.code ?? ''}`);
        }
        return reply.result ?? {};
      };

      const finish = (): void => {
        if (ended) {
          return;
        }
        ended = true;
        proc.endInput();
        void proc.killTree();
      };

      const noted = new Set<string>();
      /** The call's note: once, when its arguments are known (they stream in after the first `tool_call`). */
      const noteTool = (id: string): void => {
        if (noted.has(id)) {
          return;
        }
        noted.add(id);
        const title = turnToolNames.get(id) ?? 'tool';
        const input = toolArgs.get(id) ?? {};
        const activity = toolActivity(title, input);
        const changes = editChanges(title, input);
        emit({ kind: 'note', text: activity, ...(changes !== null ? { changes } : {}), tool: title });
        emit({ kind: 'usage', activity });
      };
      const tool = (update: Record<string, unknown>, first: boolean): void => {
        const id = text(update['toolCallId']);
        const raw = update['rawInput'];
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          toolArgs.set(id, raw as Record<string, unknown>);
        }
        if (first) {
          const content = update['content'] as ReadonlyArray<{ content?: { text?: string } }> | undefined;
          try {
            const parsed: unknown = JSON.parse(content?.[0]?.content?.text ?? '{}');
            toolArgs.set(id, typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
          } catch {
            toolArgs.set(id, {});
          }
          turnToolNames.set(id, text(update['title']));
          return;
        }
        const status = text(update['status']);
        if (status === 'in_progress' && toolArgs.has(id) && Object.keys(toolArgs.get(id) ?? {}).length > 0) {
          noteTool(id);
        }
        if (status === 'completed' || status === 'failed') {
          noteTool(id);
          const out = activityLine(text(update['rawOutput']));
          if (out !== '' || status === 'failed') {
            emit({ kind: 'note', text: `${RESULT_PREFIX}${status === 'failed' ? 'failed: ' : ''}${out}` });
          }
        }
      };

      const onUpdate = (update: Record<string, unknown>): void => {
        const kind = text(update['sessionUpdate']);
        const content = update['content'] as { type?: string; text?: string } | undefined;
        switch (kind) {
          case 'agent_message_chunk':
            turnText += text(content?.text);
            break;
          case 'agent_thought_chunk':
            thought += text(content?.text);
            break;
          case 'tool_call':
            flushThought();
            flushText();
            tool(update, true);
            break;
          case 'tool_call_update':
            tool(update, false);
            break;
          case 'usage_update': {
            const used = update['used'];
            const size = update['size'];
            if (typeof used === 'number') {
              emit({ kind: 'usage', contextTokens: used, ...(typeof size === 'number' ? { contextWindow: size } : {}) });
            }
            break;
          }
          case 'available_commands_update': {
            const cmds = update['availableCommands'];
            if (Array.isArray(cmds)) {
              emit({ kind: 'usage', commands: cmds.map((c: { name?: unknown }) => text(c.name)).filter((n) => n !== '') });
            }
            break;
          }
          default:
            break;
        }
      };
      let thought = '';
      /** The message text before a tool call is a progress line; the last segment of a turn is its answer. */
      const flushText = (): void => {
        const t = turnText.trim();
        if (t !== '') {
          emit({ kind: 'text', text: t.slice(0, 8_000) });
        }
        turnText = '';
      };
      const flushThought = (): void => {
        const t = thought.trim();
        thought = '';
        if (t !== '') {
          emit({ kind: 'note', text: `${THINK_PREFIX}${t.slice(0, THINK_MAX)}` });
        }
      };

      /** The agent's request: an approval, or a question of the AskUserQuestion tool. */
      const onRequest = (message: RpcMessage): void => {
        const rpcId = message.id!;
        if (message.method !== 'session/request_permission') {
          send({ id: rpcId, error: { code: -32601, message: `${message.method ?? 'request'} is not supported` } });
          return;
        }
        const params = message.params ?? {};
        const options = (Array.isArray(params['options']) ? params['options'] : []) as PendingRequest['options'];
        const toolCall = (params['toolCall'] ?? {}) as { toolCallId?: string; title?: string; content?: ReadonlyArray<{ content?: { text?: string } }> };
        const title = text(toolCall.title);
        const body = text(toolCall.content?.[0]?.content?.text).trim();
        const key = String(rpcId);
        flushThought();
        if (title === 'AskUserQuestion') {
          const args = toolArgs.get(text(toolCall.toolCallId));
          const asked = (Array.isArray(args?.['questions']) ? args['questions'] : []) as ReadonlyArray<{ header?: string; multiSelect?: boolean; options?: ReadonlyArray<{ label?: string; description?: string }> }>;
          const described = new Map((asked[0]?.options ?? []).map((o) => [text(o.label), o.description]));
          const choices = options.filter((o) => o.kind !== 'reject_once' && text(o.name) !== '');
          const question: WaitQuestion = {
            key: 'q0',
            ...(text(asked[0]?.header) !== '' ? { header: text(asked[0]?.header) } : {}),
            question: body !== '' ? body : 'Kimi asks you',
            options: choices.map((o) => {
              const description = described.get(text(o.name));
              return { label: text(o.name), ...(description !== undefined ? { description } : {}) };
            }),
            multiple: false,
          };
          pending.set(key, { rpcId, kind: 'question', options });
          emit({ kind: 'usage', turn: 'idle', waiting: { kind: 'question', text: question.question, requestId: key, questions: [question] } });
          return;
        }
        pending.set(key, { rpcId, kind: 'permission', options });
        emit({
          kind: 'usage',
          turn: 'idle',
          waiting: { kind: 'permission', text: permissionText({ action: title === '' ? 'tool' : title, message: body.replace(/^Requesting approval to\s*/i, '') }), requestId: key },
        });
      };

      const settleWait = (): void => {
        emit({ kind: 'usage', turn: 'busy', waiting: null });
      };

      /** New model calls since the last read: events for the run, totals for the result. */
      const readUsageEvents = async (): Promise<void> => {
        if (sessionId === null) {
          return;
        }
        const records = await readUsage(sessionId).catch(() => [] as readonly KimiUsageRecord[]);
        for (const record of records.slice(usageSeen)) {
          model = record.model ?? model;
          const inputSide = record.inputOther + record.cacheRead + record.cacheCreation;
          totalIn += inputSide;
          totalOut += record.output;
          totalCacheRead += record.cacheRead;
          const turnUsage: RunUsage = { input: record.inputOther, cacheRead: record.cacheRead, cacheCreation: record.cacheCreation, output: record.output };
          emit({ kind: 'usage', contextTokens: inputSide, turnUsage });
        }
        usageSeen = Math.max(usageSeen, records.length);
        totalCost = costOf(model, totalIn, totalOut);
      };
      const totals = (): Pick<NormalizedEvent, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'costUsd'> => ({
        tokensIn: totalIn,
        tokensOut: totalOut,
        cacheReadTokens: totalCacheRead,
        ...(totalCost !== null ? { costUsd: totalCost } : {}),
      });

      /** One prompt turn to its end; resolves with how the turn stopped. */
      const runTurn = async (prompt: string): Promise<'end_turn' | 'cancelled' | 'error'> => {
        busy = true;
        turnText = '';
        turnToolNames = new Map();
        emit({ kind: 'usage', turn: 'busy' });
        let stop: string;
        try {
          const res = resultOf(await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }));
          stop = text(res['stopReason']);
        } catch (error) {
          busy = false;
          flushThought();
          await readUsageEvents();
          emit({ kind: 'usage', ...totals() });
          emit({ kind: 'error', text: `prompt failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
          emit({ kind: 'usage', turn: 'idle' });
          return 'error';
        }
        busy = false;
        flushThought();
        await readUsageEvents();
        if (stop === 'cancelled') {
          emit({ kind: 'usage', ...totals(), turn: 'idle' });
          return 'cancelled';
        }
        return 'end_turn';
      };

      /** After a turn that ended normally: a question stands, a result ends the run. */
      const settleTurn = async (): Promise<void> => {
        const answer = turnText.trim();
        if (answer !== '') {
          emit({ kind: 'text', text: answer.slice(0, 8_000) });
        }
        const question = questionOf(answer);
        if (followUp !== null) {
          const next = followUp;
          followUp = null;
          await settle(await runTurn(next));
          return;
        }
        if (question !== null) {
          questionHold = true;
          const shaped = parseShapedQuestion(question);
          emit({ kind: 'usage', ...totals() });
          emit({ kind: 'usage', turn: 'idle', waiting: { kind: 'question', text: question, ...(shaped !== null ? { shaped } : {}) } });
          return;
        }
        emit({ kind: 'result', text: answer.slice(0, 8_000), blocked: blockedOf(answer), ...totals() });
        emit({ kind: 'usage', turn: 'idle' });
        if (!held) {
          finish();
        }
      };
      const settle = async (outcome: 'end_turn' | 'cancelled' | 'error'): Promise<void> => {
        if (outcome === 'error') {
          if (!held) {
            finish();
          }
          return;
        }
        if (outcome === 'cancelled') {
          if (steerAfterCancel !== null) {
            const next = steerAfterCancel;
            steerAfterCancel = null;
            await settle(await runTurn(next));
          }
          // An owner's interrupt: the session stands for the owner, as OpenCode's soft stop does.
          return;
        }
        await settleTurn();
      };

      const handleLine = (line: string): void => {
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          emit({ kind: 'note', detail: 'stderr', text: line.slice(0, 400) });
          return;
        }
        if (message.method !== undefined && message.id !== undefined) {
          onRequest(message);
        } else if (message.method !== undefined) {
          if (message.method === 'session/update' && !replaying) {
            onUpdate((message.params?.['update'] ?? {}) as Record<string, unknown>);
          }
        } else if (message.id !== undefined) {
          const waiting = calls.get(message.id);
          if (waiting !== undefined) {
            calls.delete(message.id);
            waiting.resolve(message);
          }
        }
      };

      proc.onStdout((chunk) => {
        buffer += chunk;
        let at = buffer.indexOf('\n');
        while (at >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf('\n');
          if (line !== '') {
            handleLine(line);
          }
        }
      });
      proc.onStderr((chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.trim() !== '') {
            emit({ kind: 'note', detail: 'stderr', text: line.slice(0, 400) });
          }
        }
      });
      // Registered before the handle's `exited`: a resume that never got a session is reported first.
      proc.onExit((code) => {
        for (const waiting of calls.values()) {
          waiting.resolve({ error: { message: `kimi exited (${code ?? 'signal'})` } });
        }
        calls.clear();
        if (!initDone && start.resumeRef !== null) {
          start.onResumeFailed?.(`kimi exited (${code ?? 'signal'}) before the session was established`);
        }
      });

      const mode = start.permissionMode === 'bypass' ? 'yolo' : 'auto';
      const compactFirst = start.compactFirst === true && start.resumeRef !== null;
      void (async (): Promise<void> => {
        try {
          resultOf(await call('initialize', { protocolVersion: 1, clientCapabilities: {} }));
          if (start.resumeRef !== null) {
            replaying = true;
            try {
              resultOf(await call('session/load', { sessionId: start.resumeRef, cwd: start.cwd, mcpServers: [] }));
            } catch (error) {
              replaying = false;
              start.onResumeFailed?.(error instanceof Error ? error.message : String(error));
              initDone = true;
              finish();
              return;
            }
            // History replays as updates; let the stream settle before it counts again.
            await new Promise((resolve) => setTimeout(resolve, 300));
            replaying = false;
            sessionId = start.resumeRef;
            // What the session spent before this run is not this run's.
            usageSeen = (await readUsage(sessionId).catch(() => [] as readonly KimiUsageRecord[])).length;
          } else {
            sessionId = text(resultOf(await call('session/new', { cwd: start.cwd, mcpServers: [] }))['sessionId']);
          }
          initDone = true;
          start.onSessionRef(sessionId);
          resultOf(await call('session/set_mode', { sessionId, modeId: mode }));
          if (start.model !== null) {
            resultOf(await call('session/set_config_option', { sessionId, configId: 'model', value: start.model }));
          }
          if (compactFirst) {
            await runTurn('/compact');
            turnText = '';
          }
          await settle(await runTurn(start.instruction));
        } catch (error) {
          emit({ kind: 'error', text: `kimi: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
          emit({ kind: 'usage', turn: 'idle' });
          finish();
        }
      })();

      return {
        pid: proc.pid,
        exited: new Promise<number | null>((resolve) => proc.onExit(resolve)),
        steer: async (steer) => {
          if (ended || sessionId === null) {
            return 'refused';
          }
          if (pending.size > 0) {
            // A held request stands: the message is a free-text reply — decline it, the text rides next.
            const [key, request] = [...pending.entries()][0]!;
            const skip = request.options.find((o) => o.kind === 'reject_once');
            pending.delete(key);
            if (skip?.optionId !== undefined) {
              send({ id: request.rpcId, result: { outcome: { outcome: 'selected', optionId: skip.optionId } } });
            } else {
              send({ id: request.rpcId, result: { outcome: { outcome: 'cancelled' } } });
            }
            followUp = steer;
            settleWait();
            return 'inject';
          }
          if (busy) {
            steerAfterCancel = steer;
            send({ method: 'session/cancel', params: { sessionId } });
            return 'inject';
          }
          const answered = questionHold;
          questionHold = false;
          if (answered) {
            emit({ kind: 'usage', waiting: null });
          }
          void runTurn(steer).then(settle);
          return 'inject';
        },
        setHold: (value) => {
          held = value;
          if (!held && !busy && pending.size === 0) {
            if (questionHold) {
              questionHold = false;
              emit({ kind: 'usage', waiting: null });
            }
            if (initDone) {
              finish();
            }
          }
        },
        interrupt: async () => {
          if (ended || !busy || sessionId === null) {
            return false;
          }
          send({ method: 'session/cancel', params: { sessionId } });
          return true;
        },
        answerPermission: async (requestId, decision) => {
          const request = pending.get(requestId);
          if (request === undefined || request.kind !== 'permission') {
            return false;
          }
          const optionId = optionFor(request.options, decision);
          pending.delete(requestId);
          send({ id: request.rpcId, result: { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } });
          settleWait();
          return true;
        },
        answerQuestion: async (formId, answers: QuestionAnswers) => {
          const request = pending.get(formId);
          if (request === undefined || request.kind !== 'question') {
            return false;
          }
          const given = answers['q0'];
          const said = (Array.isArray(given) ? given[0] : given) ?? '';
          const choice = request.options.find((o) => o.kind !== 'reject_once' && text(o.name).toLowerCase() === said.toLowerCase());
          pending.delete(formId);
          if (choice?.optionId !== undefined) {
            send({ id: request.rpcId, result: { outcome: { outcome: 'selected', optionId: choice.optionId } } });
          } else {
            const skip = request.options.find((o) => o.kind === 'reject_once');
            send({ id: request.rpcId, result: { outcome: skip?.optionId !== undefined ? { outcome: 'selected', optionId: skip.optionId } : { outcome: 'cancelled' } } });
            if (said.trim() !== '') {
              followUp = said.trim();
            }
          }
          settleWait();
          return true;
        },
        stop: async () => {
          ended = true;
          proc.endInput();
          await proc.killTree();
        },
      };
    },
  };
}
