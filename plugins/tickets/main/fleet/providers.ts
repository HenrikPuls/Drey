/**
 * The worker providers of milestone 84 (ADR-0075): one adapter per agent
 * CLI, each normalizing to the same handle — start, steer (the ladder's
 * best rung), stop, and normalized stream events for the run log.
 *
 * - `opencode` drives `opencode serve` (v2, pinned against v2.0.32) bound
 *   to loopback: the server prints its BASIC credential on stdout, a
 *   prompt POST queues the turn (delivery `steer` while one is live — the
 *   native injection rung), `interrupt` is the soft stop, and the session
 *   object carries cumulative tokens and cost for the Tickets panel
 *   footer. Progress is SUBSCRIBED, with polling as the fallback: the
 *   server's SSE `/api/event` stream (verified live, T-0051) reports
 *   text parts while they generate (`text-delta`) and every tool call as
 *   it starts and settles (`tool`); the 2 s poll keeps the usage totals,
 *   the seen-message bookkeeping and the turn end — the message list's
 *   `idle` marker stays the one authoritative "turn is over".
 * - `claude-code` drives the CLI over stream-json: stdin is held open
 *   (`--input-format stream-json`), so injection writes a user message
 *   in; resume is `--resume <sessionRef>`.
 *
 * Both adapters take their node seams (spawn, fetch, port pick) through
 * the constructor — the specs run them against fakes, and the owner's
 * live spike rounds pin the exact CLI/API shapes.
 */
import { freePort, type RunnerProcess, type SpawnFn } from './procs';
import { parseShapedQuestion } from '../../shared/question-shape';
import {
  QUESTION_MARKER,
  type PermissionDecision,
  type PermissionMode,
  type QuestionAnswers,
  type RunUsage,
  type RunWaiting,
  type SteerRung,
  type WaitQuestion,
  type WorkerProviderId,
} from './protocol';

// One table with the pure resolution rules (T-0049): the supervisor and
// the start dialog read the same capability per provider.
export { COMPACT_CAPABILITY } from './handover';

/** One line of the run's normalized stream file (`stream.jsonl`). */
export interface NormalizedEvent {
  readonly ts: string;
  readonly kind: 'note' | 'text' | 'usage' | 'result' | 'error' | 'tool' | 'text-delta';
  readonly text?: string;
  /**
   * The tool's name — on `tool` events the called tool, on a tool-call
   * note the name the telemetry counts (read/grep/glob/write/edit).
   */
  readonly tool?: string;
  /**
   * For `text-delta`: `'end'` seals the part — its `text` then carries the
   * WHOLE part (the deltas before it may have been throttled). For `tool`:
   * `'running'` | `'done'` | `'failed'`.
   */
  readonly detail?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** The part of `tokensIn` the provider served from its prompt cache. */
  readonly cacheReadTokens?: number;
  readonly costUsd?: number;
  /** One short line: what the worker is doing now (a tool call, a text opening). */
  readonly activity?: string;
  /** The current context window's size in tokens. */
  readonly contextTokens?: number;
  /** The model's context window in tokens (its limit), reported once when known. */
  readonly contextWindow?: number;
  /** The worker's turn state, when it changed: mid-turn or standing. */
  readonly turn?: 'busy' | 'idle';
  /** The slash commands the worker accepts (names without the slash). */
  readonly commands?: readonly string[];
  /** The worker began (or stopped) waiting on the owner (req-64); `since` is the event's `ts`. */
  readonly waiting?: Omit<RunWaiting, 'since'> | null;
  /**
   * Exactly one per assistant model call: THAT call's usage. The
   * providers' aggregates (`tokensIn`/`tokensOut`, the result event) are
   * cumulative over the run and must never pose as a turn's context.
   */
  readonly turnUsage?: RunUsage;
}

/**
 * The question a turn's last message asks the owner, or null when it asks
 * none: the text from the LAST line-start `QUESTION:` marker (the
 * message's start or any line start) to the message's end, trimmed. A
 * marker buried mid-message — a worker asking outside the W2 shape —
 * still sets the wait (evidence R-20261031T02050-wewb); one in running
 * prose (`Done. QUESTION: none`) does not. The W2 ASKING shape rides
 * every brief and stays the primary path; this is only the fallback.
 */
export function questionOf(text: string): string | null {
  const lines = text.split('\n');
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimStart().toUpperCase().startsWith(QUESTION_MARKER)) {
      at = i;
    }
  }
  if (at === -1) {
    return null;
  }
  const question = `${lines[at]!.trimStart().slice(QUESTION_MARKER.length)}\n${lines.slice(at + 1).join('\n')}`.trim();
  return question === '' ? null : question;
}

/** One line for a permission request: what the tool wants to do, on what. */
export function permissionText(request: {
  readonly action?: string;
  readonly resources?: readonly string[];
  readonly message?: string;
}): string {
  const what = [request.action ?? 'tool', ...(request.resources ?? [])].join(' ').trim();
  const message = request.message?.trim() ?? '';
  return message !== '' && message !== what ? `${what} — ${message}` : what;
}

/** One field of an OpenCode form (v2 `Form.Field`, the parts the fleet reads). */
interface OcFormField {
  readonly key?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly options?: ReadonlyArray<{ readonly value?: string; readonly label?: string; readonly description?: string }>;
}

/** A pending OpenCode form (v2 `Form.Info`); the `question` tool asks through one. */
export interface OcForm {
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: { readonly kind?: string };
  readonly fields?: readonly OcFormField[];
}

/**
 * The questions of a pending form, as the run's wait shows them. The
 * `question` tool puts each question into one field: `title` = its short
 * header, `description` = the question, the options' `value` = their label.
 */
export function formQuestions(form: OcForm): WaitQuestion[] {
  return (form.fields ?? [])
    .filter((f): f is OcFormField & { key: string } => typeof f.key === 'string')
    .map((f) => ({
      key: f.key,
      ...(f.title !== undefined && f.title.trim() !== '' ? { header: f.title.trim() } : {}),
      question: (f.description ?? f.title ?? '').trim() || (form.title ?? 'Question'),
      options: (f.options ?? [])
        .map((o) => ({ label: o.value ?? o.label ?? '', ...(o.description !== undefined ? { description: o.description } : {}) }))
        .filter((o) => o.label !== ''),
      multiple: f.type === 'multiselect',
    }));
}

/** One line for a question form: the first question, and how many more follow. */
export function formText(questions: readonly WaitQuestion[]): string {
  const first = questions[0]?.question ?? 'The worker asks you';
  return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first;
}

/**
 * The owner's typed answer to a question form. One question takes the
 * whole text; several take one line each, in order. A line that names a
 * choice — its number or its label — picks that choice (comma-separated
 * for a multiple choice), anything else is the owner's own answer.
 */
export function answersFromText(questions: readonly WaitQuestion[], text: string): QuestionAnswers {
  const lines = questions.length > 1 ? text.split('\n').map((l) => l.trim()).filter((l) => l !== '') : [text.trim()];
  const pick = (q: WaitQuestion, token: string): string => {
    const n = /^\d+$/.test(token) ? Number(token) : NaN;
    if (n >= 1 && n <= q.options.length) {
      return q.options[n - 1]!.label;
    }
    return q.options.find((o) => o.label.toLowerCase() === token.toLowerCase())?.label ?? token;
  };
  const answers: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const line = lines[i];
    if (line === undefined || line === '') {
      return;
    }
    answers[q.key] = q.multiple ? line.split(',').map((t) => pick(q, t.trim())).filter((t) => t !== '') : pick(q, line);
  });
  return answers;
}

/** One line for the Log and the transcript: what the owner answered. */
export function answersText(questions: readonly WaitQuestion[], answers: QuestionAnswers): string {
  return questions
    .map((q) => {
      const a = answers[q.key];
      const said = a === undefined ? '—' : typeof a === 'string' ? a : a.join(', ');
      return questions.length > 1 ? `${q.header ?? q.key}: ${said}` : said;
    })
    .join('; ');
}

/** The stream lead-in of a worker's thinking (the takeover transcript shows it quoted). */
export const THINK_PREFIX = 'thinking › ';

/** How much of one thought the stream keeps — whole, short of a runaway (req-54; was 600 chars). */
export const THINK_MAX = 8_000;

/** A tool's outcome rides the stream as a note with this lead-in (the `⎿` line under its call). */
export const RESULT_PREFIX = 'result › ';

/** Collapses a text to the one-line activity the board shows. */
export function activityLine(text: string): string {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export interface ProviderStart {
  readonly cwd: string;
  readonly instruction: string;
  readonly model: string | null;
  readonly permissionMode: PermissionMode;
  /** A previous run's session — the adapter resumes it when it can. */
  readonly resumeRef: string | null;
  /**
   * Compact the resumed session before the first prompt (T-0049): the
   * compact must complete before the instruction rides and stay
   * invisible as a turn. Only meaningful with a `resumeRef`.
   */
  readonly compactFirst?: boolean;
  /**
   * The context window the worker compacts at (req-80); 0 or absent =
   * the model's own. OpenCode only — a CLI worker ignores it.
   */
  readonly contextCap?: number;
  /**
   * The resume could not be established (a missing session, a CLI
   * refusal) — reported instead of prompting; the supervisor falls
   * back to a fresh worker under the same run id. Fires at most once,
   * always before the first successful prompt (a failure after a
   * successful resume fails the run normally).
   */
  readonly onResumeFailed?: (reason: string) => void;
  /**
   * Deliver NO first prompt — a quiet start (req-75): the session is
   * created or resumed, the subscription and the poll start, and the
   * worker stands until steered (the supervisor wraps the brief into
   * the owner's first message). Honored by opencode; claude-code
   * ignores it.
   */
  readonly holdAtSpawn?: boolean;
  readonly ticketId: string;
  /** Events land here; the run store writes them to the stream file. */
  readonly onEvent: (event: NormalizedEvent) => void;
  /** The session to steer/resume with, as soon as the provider reports it. */
  readonly onSessionRef: (ref: string) => void;
  /**
   * What a later runner needs to re-attach to this worker (the server's
   * address and its per-boot credential), reported once the worker is up.
   * The supervisor keeps it in a file of the run's own — never in the run
   * record, which crosses to the board.
   */
  readonly onAttachInfo?: (info: { readonly address: string; readonly password: string; readonly pid: number | null }) => void;
  /**
   * What the resumed session had already spent before this run (req-53):
   * the adapter reports the session's totals minus this base. Absent on
   * a resume, the adapter reads it from the session before its first
   * prompt and reports it through `onUsageBase`; a fresh session starts
   * at zero.
   */
  readonly usageBase?: UsageTotals;
  readonly onUsageBase?: (base: UsageTotals) => void;
}

/** A session's cumulative usage (OpenCode keeps it per session, across runs). */
export interface UsageTotals {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number | null;
}

export const ZERO_USAGE: UsageTotals = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, costUsd: null };

/** The session's totals as this run's own: minus the base, never below zero. */
export function usageSince(total: UsageTotals, base: UsageTotals): UsageTotals {
  return {
    tokensIn: Math.max(0, total.tokensIn - base.tokensIn),
    tokensOut: Math.max(0, total.tokensOut - base.tokensOut),
    cacheReadTokens: Math.max(0, total.cacheReadTokens - base.cacheReadTokens),
    costUsd: total.costUsd === null ? null : Math.max(0, total.costUsd - (base.costUsd ?? 0)),
  };
}

/** What re-attaching to a worker that outlived its runner takes (OpenCode). */
export interface AttachInfo {
  readonly address: string;
  readonly password: string;
  readonly sessionRef: string;
  /** Epoch ms of the run's start: an idle marker before it belongs to an earlier turn. */
  readonly runStartedMs: number;
  /** Messages completed at or before this instant are already in the run's stream. */
  readonly seenBeforeMs: number;
  readonly pid: number | null;
  /** Kills the worker's process tree — the adapter holds no process handle of an attached worker. */
  kill(): Promise<void>;
}

export interface WorkerHandle {
  readonly pid: number | null;
  /** Resolves with the worker's exit code (null on signal/kill). */
  readonly exited: Promise<number | null>;
  /** Best available steer rung for this provider. */
  steer(text: string): Promise<SteerRung>;
  /** Hard stop: provider soft-abort first, then the tree-kill. */
  stop(): Promise<void>;
  /**
   * Human takeover (absent when the provider cannot do it): while held the
   * adapter does not treat a finished turn as the end of the run, so the
   * worker's session stays up for the owner to drive; releasing it lets the
   * next turn end count again (a worker that is idle by then ends the run).
   */
  setHold?(held: boolean): void;
  /**
   * The soft stop of the current turn — the session and the worker process
   * stay (unlike `stop`). False when there is nothing to interrupt.
   */
  interrupt?(): Promise<boolean>;
  /**
   * Answers the provider's pending permission request (req-64; OpenCode).
   * False when the request is gone or the server refused the reply.
   */
  answerPermission?(requestId: string, decision: PermissionDecision): Promise<boolean>;
  /**
   * Answers the provider's pending question form (OpenCode's `question`
   * tool): the worker's tool call returns the answers and its turn goes on.
   * False when the form is gone or the server refused the reply.
   */
  answerQuestion?(formId: string, answers: QuestionAnswers): Promise<boolean>;
}

export interface ProviderAdapter {
  readonly id: WorkerProviderId;
  readonly label: string;
  /** True when steer reaches a live worker without ending it. */
  readonly liveInject: boolean;
  /**
   * True when a resumed session can stand without a first prompt — an
   * empty instruction binds the session and posts nothing (req-80;
   * OpenCode's server). A CLI needs a prompt to run at all.
   */
  readonly promptless?: boolean;
  spawn(start: ProviderStart): WorkerHandle;
  /**
   * A handle on a worker that outlived its runner (absent when the provider
   * cannot): the same steer / interrupt / stop / hold surface, bound to the
   * running server instead of a process this runner started.
   */
  attach?(start: ProviderStart, info: AttachInfo): WorkerHandle;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type NowFn = () => Date;

const nowIso = (now: NowFn): string => now().toISOString();

// ---------------------------------------------------------------------------
// claude-code — stream-json over stdio

interface ClaudeUsage {
  readonly input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens?: number;
}

export function claudeCodeAdapter(spawnFn: SpawnFn, now: NowFn = (): Date => new Date()): ProviderAdapter {
  const userMessage = (text: string): string =>
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

  return {
    id: 'claude-code',
    label: 'Claude Code',
    liveInject: true,
    spawn(start) {
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        start.permissionMode === 'bypass' ? 'bypassPermissions' : 'acceptEdits',
        ...(start.model !== null ? ['--model', start.model] : []),
        ...(start.resumeRef !== null ? ['--resume', start.resumeRef] : []),
      ];
      const proc = spawnFn('claude', args, { cwd: start.cwd });
      let buffer = '';
      // Takeover: a held worker keeps its stdin open past a finished turn so
      // the owner can prompt it again; otherwise the finished turn closes it
      // and the process exits (the run ends). `busy` is "a prompt is out and
      // its result has not come back".
      let held = false;
      /** The last turn asked the owner something (req-64): stand until answered. */
      let questionHold = false;
      let busy = true;
      let inputClosed = false;
      // T-0049: the resume's health signal — a CLI that exits before its
      // init event never established the session, so the supervisor respawns
      // fresh instead of failing the run.
      let initSeen = false;
      // T-0049 compact-first: the `/compact` user message rides before the
      // instruction and its result is awaited (spike 1: native routing, zero
      // model usage) — the instruction follows only once the compact settled.
      const compactFirst = start.compactFirst === true && start.resumeRef !== null;
      let compactPending = compactFirst;
      const sendInstruction = (): void => {
        proc.write(userMessage(start.instruction));
        if (!busy) {
          busy = true;
          start.onEvent({ ts: nowIso(now), kind: 'usage', turn: 'busy' });
        }
      };
      const closeInput = (): void => {
        if (!inputClosed) {
          inputClosed = true;
          proc.endInput();
        }
      };
      proc.onStdout((chunk) => {
        buffer += chunk;
        let at = buffer.indexOf('\n');
        while (at >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf('\n');
          if (line === '') {
            continue;
          }
          let event: {
            type?: string;
            subtype?: string;
            session_id?: string;
            slash_commands?: unknown[];
            message?: {
              usage?: ClaudeUsage;
              content?: ReadonlyArray<{ type?: string; name?: string; text?: string; thinking?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean }>;
            };
            usage?: ClaudeUsage;
            total_cost_usd?: number;
            result?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            start.onEvent({ ts: nowIso(now), kind: 'note', text: line.slice(0, 400) });
            continue;
          }
          if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
            initSeen = true;
            start.onSessionRef(event.session_id);
            if (Array.isArray(event.slash_commands)) {
              const names = event.slash_commands.filter((c): c is string => typeof c === 'string').map((c) => c.replace(/^\//, ''));
              start.onEvent({ ts: nowIso(now), kind: 'usage', commands: names });
            }
            continue;
          }
          if (event.type === 'user' && event.message !== undefined) {
            for (const part of event.message.content ?? []) {
              if (part.type !== 'tool_result') {
                continue;
              }
              const raw = typeof part.content === 'string' ? part.content : '';
              const first = activityLine(raw);
              if (first !== '' || part.is_error === true) {
                start.onEvent({ ts: nowIso(now), kind: 'note', text: `${RESULT_PREFIX}${part.is_error === true ? 'failed: ' : ''}${first}` });
              }
            }
            continue;
          }
          if (event.type === 'assistant' && event.message !== undefined) {
            // Every model call reports its own usage: the input side of
            // the latest one is the size of the context right now, and
            // the per-turn copy (turnUsage) feeds the run's telemetry —
            // the aggregate on the later result event never does.
            const usage = event.message.usage;
            const contextTokens =
              usage === undefined
                ? undefined
                : (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            const turnUsage: RunUsage | undefined =
              usage === undefined
                ? undefined
                : {
                    input: usage.input_tokens ?? null,
                    cacheRead: usage.cache_read_input_tokens ?? null,
                    cacheCreation: usage.cache_creation_input_tokens ?? null,
                    output: usage.output_tokens ?? null,
                  };
            const parts = event.message.content ?? [];
            // The transcript the takeover tab shows: thinking, replies and
            // every tool call, as the opencode adapter writes them.
            let activity = '';
            for (const part of parts) {
              if (part.type === 'thinking' && (part.thinking ?? '').trim() !== '') {
                start.onEvent({ ts: nowIso(now), kind: 'note', text: `${THINK_PREFIX}${(part.thinking ?? '').trim().slice(0, THINK_MAX)}` });
              } else if (part.type === 'text' && (part.text ?? '').trim() !== '') {
                activity = activityLine(part.text ?? '');
                start.onEvent({ ts: nowIso(now), kind: 'text', text: (part.text ?? '').slice(0, 8_000) });
              } else if (part.type === 'tool_use') {
                activity = toolActivity(part.name, part.input);
                start.onEvent({
                  ts: nowIso(now),
                  kind: 'note',
                  text: activity,
                  ...(part.name !== undefined ? { tool: part.name } : {}),
                });
              }
            }
            if (contextTokens !== undefined || activity !== '') {
              start.onEvent({
                ts: nowIso(now),
                kind: 'usage',
                ...(contextTokens !== undefined ? { contextTokens } : {}),
                ...(turnUsage !== undefined ? { turnUsage } : {}),
                ...(activity !== '' ? { activity } : {}),
              });
            }
            continue;
          }
          if (event.type === 'result') {
            // The result event carries the run's cumulative usage.
            const usage: ClaudeUsage = event.usage ?? event.message?.usage ?? {};
            const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            const tokensIn = (usage.input_tokens ?? 0) + cacheReadTokens;
            const tokensOut = usage.output_tokens ?? 0;
            const cost = typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {};
            const question = questionOf(event.result ?? '');
            busy = false;
            if (question !== null) {
              // A question to the owner (req-64): the turn is not the
              // step's end — the input stays open for the answer.
              questionHold = true;
              const shaped = parseShapedQuestion(question);
              start.onEvent({ ts: nowIso(now), kind: 'usage', tokensIn, tokensOut, cacheReadTokens, ...cost });
              start.onEvent({
                ts: nowIso(now),
                kind: 'usage',
                turn: 'idle',
                waiting: { kind: 'question', text: question, ...(shaped !== null ? { shaped } : {}) },
              });
              continue;
            }
            start.onEvent({
              ts: nowIso(now),
              kind: 'result',
              text: (event.result ?? '').slice(0, 8_000),
              tokensIn,
              tokensOut,
              cacheReadTokens,
              ...cost,
            });
            start.onEvent({ ts: nowIso(now), kind: 'usage', turn: 'idle' });
            if (compactPending) {
              // The compact's own result: the session is compacted, the
              // real instruction follows now — the input stays open.
              compactPending = false;
              sendInstruction();
              return;
            }
            if (!held) {
              closeInput();
            }
          }
        }
      });
      proc.onStderr((chunk) => {
        for (const line of chunk.split('\n')) {
          if (line.trim() !== '') {
            start.onEvent({ ts: nowIso(now), kind: 'note', text: line.slice(0, 400) });
          }
        }
      });
      // Registered before the handle's exited promise so it fires first:
      // the supervisor's fallback guard is set synchronously before the
      // exit can be misread as the run's end.
      proc.onExit((code) => {
        if (!initSeen && start.resumeRef !== null) {
          start.onResumeFailed?.(`the CLI exited (${code ?? 'signal'}) before its session was established`);
        }
      });
      if (compactFirst) {
        proc.write(userMessage('/compact'));
      } else {
        proc.write(userMessage(start.instruction));
      }
      return {
        pid: proc.pid,
        exited: new Promise<number | null>((resolve) => proc.onExit(resolve)),
        steer: async (text) => {
          if (inputClosed) {
            return 'refused';
          }
          proc.write(userMessage(text));
          // The owner's message answers an open question: the next
          // finished turn ends the run again (unless the owner holds it).
          const answered = questionHold;
          questionHold = false;
          if (!busy || answered) {
            busy = true;
            start.onEvent({ ts: nowIso(now), kind: 'usage', turn: 'busy', ...(answered ? { waiting: null } : {}) });
          }
          return 'inject';
        },
        setHold: (value) => {
          held = value;
          // Released while standing: nothing more is coming, the run ends.
          if (!held) {
            if (questionHold) {
              questionHold = false;
              start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
            }
            if (!busy) {
              closeInput();
            }
          }
        },
        // The stream-json control request the Claude SDK sends for its own
        // interrupt: the turn stops, the session and the process stay.
        interrupt: async () => {
          if (inputClosed || !busy) {
            return false;
          }
          proc.write(
            `${JSON.stringify({ type: 'control_request', request_id: `drey-${now().getTime()}`, request: { subtype: 'interrupt' } })}\n`,
          );
          return true;
        },
        stop: async () => {
          closeInput();
          await proc.killTree();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// opencode — v2 server API over loopback (pinned against v2.0.32)

interface OcUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cache?: { readonly read?: number; readonly write?: number };
}

interface OcContentPart {
  readonly type?: string;
  readonly text?: string;
  /** A `tool` part: the call's id, the tool's name and its input. */
  readonly id?: string;
  readonly name?: string;
  readonly state?: { readonly input?: Readonly<Record<string, unknown>> };
}

/** One line for a tool call: `read src/a.ts`, `shell git status`, `grep prepareWorktree`. */
export function toolActivity(name: string | undefined, input: Readonly<Record<string, unknown>> | undefined): string {
  const questions = input?.['questions'];
  if (name === 'question' && Array.isArray(questions)) {
    // OpenCode's `question` tool: the line is what it asks, not a bare "question".
    const first = (questions[0] as { question?: unknown } | undefined)?.question;
    return activityLine(`asks ${typeof first === 'string' ? first : 'the owner'}`);
  }
  const target = input?.['path'] ?? input?.['filePath'] ?? input?.['file_path'] ?? input?.['command'] ?? input?.['pattern'] ?? '';
  return activityLine(`${name ?? 'tool'} ${typeof target === 'string' ? target : ''}`);
}

/** One message-list item — FLAT in v2 (no v1-style `info` wrapper). */
interface OcMessage {
  readonly id?: string;
  readonly type?: string;
  readonly content?: ReadonlyArray<OcContentPart>;
  readonly tokens?: OcUsage;
  readonly cost?: number;
  readonly time?: { readonly created?: number; readonly completed?: number };
  /** The idle marker's verdict on the turn: `succeeded`, `interrupted`, `failed`. */
  readonly outcome?: string;
  /** Why a turn failed — the provider's refusal (`provider.quota`, 429, …). */
  readonly error?: { readonly type?: string; readonly message?: string; readonly status?: number };
}

/** The error line of a turn the provider refused: type, status, message. */
export function providerErrorText(error: OcMessage['error']): string {
  const head = [error?.type ?? 'provider error', error?.status !== undefined ? String(error.status) : null]
    .filter((part) => part !== null)
    .join(' ');
  return `${head}: ${error?.message ?? 'the turn failed'}`.slice(0, 400);
}

/**
 * One SSE event of `GET /api/event`, as verified live against v2.0.32
 * (T-0051 spike — names pinned, shapes truncated to what the adapter
 * reads): `session.text.delta|ended`, `session.tool.input.started`,
 * `session.tool.called`, `session.tool.success|error`,
 * `session.step.started|ended`, `session.usage.updated`. Everything else
 * (server.connected, shell.exited, project.updated, …) is ignored.
 */
interface OcServerEvent {
  readonly type?: string;
  readonly data?: {
    readonly sessionID?: string;
    readonly assistantMessageID?: string;
    readonly ordinal?: number;
    /** A `tool` part: the call's id. */
    readonly id?: string;
    readonly name?: string;
    readonly text?: string;
    readonly delta?: string;
    readonly input?: Readonly<Record<string, unknown>>;
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly tokens?: OcUsage;
    readonly cost?: number;
  };
}

interface OcSession {
  readonly cost?: number;
  readonly tokens?: OcUsage;
}

/** One pending permission request (v2 `Permission.Request`, req-64). */
interface OcPermissionRequest {
  readonly id?: string;
  readonly action?: string;
  readonly resources?: readonly string[];
  readonly message?: string;
}

/** One model-catalog entry — v2's `Model.Info` (`limit.context` is the window). */
interface OcModel {
  readonly id?: string;
  readonly modelID?: string;
  readonly providerID?: string;
  readonly limit?: { readonly context?: number };
}

/**
 * The v2 surface the adapter speaks, pinned by the owner's spike against
 * v2.0.32: the server prints `server password <token>` on stdout, every
 * request carries HTTP BASIC auth (`opencode:<token>`), responses wrap in
 * `{data}`, and a turn ends with an `idle` message in the list.
 */
export const OPENCODE_API = {
  info: '/api/info',
  createSession: '/api/session',
  session: (id: string): string => `/api/session/${id}`,
  prompt: (id: string): string => `/api/session/${id}/prompt`,
  messages: (id: string): string => `/api/session/${id}/message`,
  interrupt: (id: string): string => `/api/session/${id}/interrupt`,
  /** The server's SSE event stream (T-0051): `data:` lines, one `{id, type, data}` JSON object each. */
  event: '/api/event',
  /** The project's custom commands (`GET`, `{data: [{name, …}]}`). */
  commands: '/api/command',
  command: (id: string): string => `/api/session/${id}/command`,
  compact: (id: string): string => `/api/session/${id}/compact`,
  /** The session's pending permission requests (`GET`, `{data: [{id, action, resources, message?}]}`; req-64). */
  permissions: (id: string): string => `/api/session/${id}/permission`,
  /** The answer to one (`POST {decision: once | always | reject}`, 204). */
  permissionReply: (id: string, requestId: string): string =>
    `/api/session/${id}/permission/${encodeURIComponent(requestId)}/reply`,
  /** The session's pending forms — the `question` tool asks through one (`GET`, `{data: [Form.Info]}`). */
  forms: (id: string): string => `/api/session/${id}/form`,
  /** The answer to one (`POST {answer: {q0: …}}`, 204). */
  formReply: (id: string, formId: string): string => `/api/session/${id}/form/${encodeURIComponent(formId)}/reply`,
  /** The model catalog (`GET`, `{data: Model.Info[]}`). */
  models: '/api/model',
  /** The server's default model (`GET`, `{data: Model.Info | undefined}`). */
  modelDefault: '/api/model/default',
} as const;

/** A dropped event subscription is retried after this long; polling covers the gap. */
export const EVENT_RETRY_MS = 2_000;

/**
 * Live `text-delta` events are capped at this spacing per part (the seal
 * carries the whole part, so nothing is lost) — every append to the run's
 * stream file also rewrites `run.json`, and per-token deltas would melt
 * that path. Two per second reads live in the watch view, which polls at
 * the same cadence.
 */
export const TEXT_DELTA_MIN_MS = 500;

/** The slash commands every OpenCode worker has besides the project's own. */
export const OPENCODE_BUILTIN_COMMANDS: readonly string[] = ['compact'];

/**
 * The prompt body with the model pin in the v2 shape (`providerID` +
 * `modelID`, split once at the first slash — e.g.
 * `zai-coding-plan/glm-5.3-flash`). A pin without a slash rides as the
 * modelID with an empty provider (the server resolves it or refuses —
 * visible in the stream, never guessed).
 */
export function modelBody(model: string | null, text: string): {
  text: string;
  model?: { providerID: string; modelID: string };
} {
  if (model === null || model.trim() === '') {
    return { text };
  }
  const slashAt = model.indexOf('/');
  if (slashAt === -1) {
    return { text, model: { providerID: '', modelID: model.trim() } };
  }
  return {
    text,
    model: {
      providerID: model.slice(0, slashAt).trim(),
      modelID: model.slice(slashAt + 1).trim(),
    },
  };
}

/**
 * The inline OpenCode config that caps the pinned model's window (req-80):
 * OpenCode auto-compacts against `limit.context`, and an override that
 * names `context` alone is dropped whole (measured on v2.0.32), so the
 * output limit rides too. Null without a cap or a `provider/model` pin.
 */
export function opencodeCapConfig(model: string | null, cap: number): string | null {
  if (model === null || !(cap > 0)) {
    return null;
  }
  const slashAt = model.indexOf('/');
  if (slashAt <= 0 || slashAt === model.length - 1) {
    return null;
  }
  const providerID = model.slice(0, slashAt).trim();
  const modelID = stripVariant(model.slice(slashAt + 1).trim());
  const limit = { context: Math.floor(cap), output: Math.min(32_000, Math.floor(cap / 4)) };
  return JSON.stringify({ provider: { [providerID]: { models: { [modelID]: { limit } } } } });
}

/** Drops a `#variant` suffix a pin or a catalog id may carry (`glm-5.3#fast`). */
export function stripVariant(id: string): string {
  const at = id.indexOf('#');
  return at === -1 ? id : id.slice(0, at);
}

/** How long a stop waits for the server's answer to the soft interrupt before it kills the tree. */
export const INTERRUPT_WAIT_MS = 3_000;

export function opencodeAdapter(
  spawnFn: SpawnFn,
  fetchFn: FetchFn = fetch,
  pickPort: () => Promise<number> = freePort,
  now: NowFn = (): Date => new Date(),
): ProviderAdapter {
  const build = (start: ProviderStart, attached: AttachInfo | null): WorkerHandle => {
    const state = {
      sessionRef: start.resumeRef,
      alive: true,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      costUsd: null as number | null,
      /** The resumed session's earlier spend; null until a resume has read it. */
      usageBase: (start.usageBase ?? (attached !== null || start.resumeRef === null ? ZERO_USAGE : null)) as UsageTotals | null,
      startedAt: 0,
      turnDone: false,
      /** A human drives the session: an idle marker is not the run's end. */
      held: false,
      /** The turn ended with a question to the owner (req-64): stand until answered. */
      questionHold: false,
      /** The prompt time whose question was already reported (one report per turn). */
      questionReportedFor: -1,
      /** The permission request now reported as the wait, or null. */
      permissionId: null as string | null,
      /** The question form now reported as the wait, or null. */
      formId: null as string | null,
      turn: undefined as 'busy' | 'idle' | undefined,
      /** Idle markers older than this belong to an earlier turn. */
      lastPromptAt: 0,
      ended: false,
      seenAssistant: new Set<string>(),
      seenTools: new Set<string>(),
      /** Messages settled at or before this instant are history, never re-emitted (attach and resume). */
      seenBeforeMs: (attached?.seenBeforeMs ?? null) as number | null,
      lastText: '',
      contextTokens: 0,
    };
    let server: RunnerProcess | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    /** Consecutive failed polls of an attached worker: three in a row = its server is gone. */
    let pollFailures = 0;

    const exitResolve = { current: null as ((code: number | null) => void) | null };
    let finished = false;
    const basicAuth = (password: string): Record<string, string> => ({
      // v2 speaks HTTP BASIC with the fixed user `opencode`.
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    });
    const finish = (code: number | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      state.alive = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      stopEvents();
      exitResolve.current?.(code);
    };

    const base = (): string => `http://127.0.0.1:${server === null ? 0 : (server as { port?: number }).port ?? 0}`;

    // Filled in by boot(); the closed-over helpers read through `server`.
    let address = '';
    let auth: Record<string, string> = {};

    const postPrompt = async (text: string): Promise<void> => {
      if (state.sessionRef === null || address === '') {
        return;
      }
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.prompt(state.sessionRef)}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          // The v2 API takes the model per message as {providerID, modelID};
          // the fleet's model pin spells that `providerID/modelID` (one
          // split at the first slash). A pin without a slash is a note,
          // never a guess.
          body: JSON.stringify(modelBody(start.model, text)),
        });
        if (!res.ok) {
          start.onEvent({ ts: nowIso(now), kind: 'error', text: `prompt failed: ${res.status}` });
        }
      } catch (error) {
        if (state.alive) {
          start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 300) });
        }
      }
    };

    /** The project's custom commands, fetched once the server is up. */
    const customCommands = new Set<string>();
    const loadCommands = async (): Promise<void> => {
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.commands}`, { headers: auth });
        if (res.ok) {
          const body = (await res.json()) as { data?: ReadonlyArray<{ name?: string }> };
          for (const c of body.data ?? []) {
            if (typeof c.name === 'string') {
              customCommands.add(c.name);
            }
          }
        }
      } catch {
        // the built-ins alone are still offered
      }
      start.onEvent({ ts: nowIso(now), kind: 'usage', commands: [...OPENCODE_BUILTIN_COMMANDS, ...customCommands] });
    };

    /**
     * The model's context window, asked of the server once per worker
     * (the catalog does not change mid-run): the entry the run's pin
     * names — `providerID` + `id` first, then `providerID` + `modelID`
     * (a config-added model can key differently from its upstream id),
     * a `#variant` suffix stripped before matching; without a pin the
     * server's default model. A miss or a failed fetch is one stream
     * note — the number is never guessed.
     */
    const reportContextWindow = async (): Promise<void> => {
      const note = (why: string): void => {
        start.onEvent({ ts: nowIso(now), kind: 'note', text: `context window not reported — ${why}` });
      };
      try {
        let info: OcModel | undefined;
        if (start.model !== null && start.model.trim() !== '') {
          const slashAt = start.model.indexOf('/');
          const providerID = (slashAt === -1 ? '' : start.model.slice(0, slashAt)).trim();
          const pinned = stripVariant((slashAt === -1 ? start.model : start.model.slice(slashAt + 1)).trim());
          const res = await fetchFn(`${address}${OPENCODE_API.models}`, { headers: auth });
          if (!res.ok) {
            note(`the model catalog fetch failed (${res.status})`);
            return;
          }
          const catalog = ((await res.json()) as { data?: ReadonlyArray<OcModel> }).data ?? [];
          info =
            catalog.find((m) => m.providerID === providerID && stripVariant(m.id ?? '') === pinned) ??
            catalog.find((m) => m.providerID === providerID && stripVariant(m.modelID ?? '') === pinned);
          if (info === undefined) {
            note(`the catalog has no entry for ${providerID === '' ? '' : `${providerID}/`}${pinned}`);
            return;
          }
        } else {
          const res = await fetchFn(`${address}${OPENCODE_API.modelDefault}`, { headers: auth });
          if (!res.ok) {
            note(`the default model fetch failed (${res.status})`);
            return;
          }
          info = ((await res.json()) as { data?: OcModel }).data;
          if (info === undefined) {
            note('the server names no default model');
            return;
          }
        }
        const window = info.limit?.context;
        if (typeof window !== 'number' || window <= 0) {
          note('the model entry carries no context limit');
          return;
        }
        start.onEvent({ ts: nowIso(now), kind: 'usage', contextWindow: window });
      } catch (error) {
        note(String(error).slice(0, 160));
      }
    };

    /**
     * A `/name args` prompt that names a command the server knows runs as
     * that command (compact, or the project's own); anything else is plain
     * text for the model. False = not a command, send it as a prompt.
     */
    const postCommand = async (name: string, args: string): Promise<boolean> => {
      if (state.sessionRef === null || address === '') {
        return false;
      }
      const isCompact = name === 'compact';
      if (!isCompact && !customCommands.has(name)) {
        return false;
      }
      try {
        const res = await fetchFn(
          `${address}${isCompact ? OPENCODE_API.compact(state.sessionRef) : OPENCODE_API.command(state.sessionRef)}`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify(isCompact ? {} : { name, text: args }),
          },
        );
        if (!res.ok) {
          start.onEvent({ ts: nowIso(now), kind: 'error', text: `/${name} failed: ${res.status}` });
        }
        return res.ok;
      } catch (error) {
        start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 300) });
        return false;
      }
    };

    /** Kills the worker's process tree; an attached worker has no process handle here. */
    const killWorker = async (): Promise<void> => {
      if (server !== null) {
        await server.killTree();
      } else if (attached !== null) {
        await attached.kill();
        finish(null);
      }
    };

    /** Text of the message's `text` content parts, trimmed. */
    const messageText = (m: OcMessage): string =>
      (m.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();

    /** The session's cumulative usage as the server reports it (input counts cache reads). */
    const sessionTotals = (s: OcSession): UsageTotals => {
      const cacheReadTokens = s.tokens?.cache?.read ?? 0;
      return {
        tokensIn: (s.tokens?.input ?? 0) + cacheReadTokens,
        tokensOut: s.tokens?.output ?? 0,
        cacheReadTokens,
        costUsd: s.cost ?? null,
      };
    };

    /** Emits the run's own usage (totals minus base) when any number moved. */
    const reportUsage = (total: UsageTotals): void => {
      if (state.usageBase === null) {
        return;
      }
      const own = usageSince(total, state.usageBase);
      if (
        own.tokensIn === state.tokensIn &&
        own.tokensOut === state.tokensOut &&
        own.cacheReadTokens === state.cacheReadTokens &&
        own.costUsd === state.costUsd
      ) {
        return;
      }
      state.tokensIn = own.tokensIn;
      state.tokensOut = own.tokensOut;
      state.cacheReadTokens = own.cacheReadTokens;
      state.costUsd = own.costUsd;
      start.onEvent({
        ts: nowIso(now),
        kind: 'usage',
        tokensIn: own.tokensIn,
        tokensOut: own.tokensOut,
        cacheReadTokens: own.cacheReadTokens,
        ...(own.costUsd !== null ? { costUsd: own.costUsd } : {}),
      });
    };

    // --- the live event subscription (T-0051) ----------------------------
    // The SSE half: what streams while a turn generates. The poll below
    // keeps running — it owns the turn end, the usage totals and every
    // message the subscription missed.
    /** Final text parts per message id, sealed by `session.text.ended`. */
    const sseParts = new Map<string, string[]>();
    /** Tool names by call id (`session.tool.success` reports no name). */
    const toolNames = new Map<string, string>();
    /** When the last delta of a part was forwarded (the throttle). */
    const deltaAt = new Map<string, number>();
    let eventAbort: AbortController | null = null;
    let eventRetry: ReturnType<typeof setTimeout> | null = null;

    const stopEvents = (): void => {
      eventAbort?.abort();
      eventAbort = null;
      if (eventRetry !== null) {
        clearTimeout(eventRetry);
        eventRetry = null;
      }
    };

    const onServerEvent = (raw: string): void => {
      if (raw === '' || !state.alive || state.sessionRef === null) {
        return;
      }
      let event: OcServerEvent;
      try {
        event = JSON.parse(raw) as OcServerEvent;
      } catch {
        return;
      }
      const data = event.data;
      if (data?.sessionID !== state.sessionRef) {
        return;
      }
      const ts = nowIso(now);
      switch (event.type) {
        case 'session.text.delta': {
          if (data.assistantMessageID === undefined || typeof data.delta !== 'string') {
            return;
          }
          const key = `${data.assistantMessageID}#${data.ordinal ?? 0}`;
          const at = now().getTime();
          const last = deltaAt.get(key);
          if (last !== undefined && at - last < TEXT_DELTA_MIN_MS) {
            return; // throttled — the seal brings the whole part
          }
          deltaAt.set(key, at);
          start.onEvent({ ts, kind: 'text-delta', text: data.delta });
          return;
        }
        case 'session.text.ended': {
          if (data.assistantMessageID === undefined) {
            return;
          }
          const text = typeof data.text === 'string' ? data.text : '';
          const parts = sseParts.get(data.assistantMessageID) ?? [];
          parts.push(text);
          sseParts.set(data.assistantMessageID, parts);
          if (text.trim() !== '') {
            start.onEvent({ ts, kind: 'text-delta', text, detail: 'end', activity: activityLine(text) });
          }
          return;
        }
        case 'session.tool.input.started': {
          if (typeof data.id !== 'string') {
            return;
          }
          const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'tool';
          toolNames.set(data.id, name);
          start.onEvent({ ts, kind: 'tool', tool: name, detail: 'running', activity: name });
          return;
        }
        case 'session.tool.called': {
          if (typeof data.id !== 'string') {
            return;
          }
          const name = toolNames.get(data.id) ?? 'tool';
          // The poll must not repeat this call as its own note.
          state.seenTools.add(data.id);
          const activity = toolActivity(name, data.input);
          start.onEvent({ ts, kind: 'tool', tool: name, text: activity, activity });
          return;
        }
        case 'session.tool.success':
        case 'session.tool.error': {
          if (typeof data.id !== 'string') {
            return;
          }
          const failed = event.type === 'session.tool.error';
          const name = toolNames.get(data.id) ?? 'tool';
          state.seenTools.add(data.id);
          const first = activityLine((data.content ?? []).map((part) => part.text ?? '').join('\n'));
          start.onEvent({
            ts,
            kind: 'tool',
            tool: name,
            detail: failed ? 'failed' : 'done',
            ...(first !== '' ? { text: `${RESULT_PREFIX}${failed ? 'failed: ' : ''}${first}` } : {}),
          });
          return;
        }
        case 'session.step.started': {
          if (state.turn !== 'busy') {
            state.turn = 'busy';
            start.onEvent({ ts, kind: 'usage', turn: 'busy' });
          }
          return;
        }
        case 'session.step.ended': {
          const contextTokens = (data.tokens?.input ?? 0) + (data.tokens?.cache?.read ?? 0);
          if (contextTokens > 0) {
            state.contextTokens = contextTokens;
            start.onEvent({ ts, kind: 'usage', contextTokens });
          }
          return;
        }
        case 'session.usage.updated': {
          reportUsage(sessionTotals({ tokens: data.tokens, cost: data.cost }));
          return;
        }
        default:
          return;
      }
    };

    /**
     * Subscribes to `/api/event` (SSE, BASIC auth). A dropped or refused
     * stream is noise — the poll still covers everything — and is retried
     * after `EVENT_RETRY_MS` until the run ends.
     */
    const subscribeEvents = (): void => {
      if (eventAbort !== null || !state.alive || address === '') {
        return;
      }
      const controller = new AbortController();
      eventAbort = controller;
      void (async (): Promise<void> => {
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.event}`, { headers: auth, signal: controller.signal });
          if (!res.ok || res.body === null) {
            throw new Error(`event stream answered ${res.status}`);
          }
          const reader = (res.body as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf('\n');
              if (line.startsWith('data:')) {
                onServerEvent(line.slice(5).trim());
              }
            }
          }
        } catch {
          // aborted with the run, or the stream dropped — retried below
        }
        if (controller.signal.aborted || !state.alive) {
          return;
        }
        eventAbort = null;
        eventRetry = setTimeout(subscribeEvents, EVENT_RETRY_MS);
      })();
    };

    /**
     * A resumed session's spend before this run (req-53): OpenCode's
     * session totals are cumulative, so without the base a resumed run
     * re-counted every earlier run of the session. Unreadable = zero, said
     * in the stream.
     */
    const readUsageBase = async (): Promise<void> => {
      if (state.usageBase !== null || state.sessionRef === null) {
        return;
      }
      let base: UsageTotals | null = null;
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.session(state.sessionRef)}`, { headers: auth });
        if (res.ok) {
          const s = ((await res.json()) as { data?: OcSession }).data;
          base = s === undefined ? null : sessionTotals(s);
        }
      } catch {
        // reported below
      }
      if (base === null) {
        start.onEvent({
          ts: nowIso(now),
          kind: 'note',
          text: "the resumed session's earlier usage could not be read — this run's token counts include it",
        });
      }
      state.usageBase = base ?? ZERO_USAGE;
      start.onUsageBase?.(state.usageBase);
    };

    /**
     * T-0049 resume pre-flight: a session the server no longer has (it
     * aged out, the storage was cleared) would otherwise surface as a
     * failed prompt POST on a live worker — reported here instead, before
     * anything is prompted, so the supervisor can respawn fresh.
     */
    const preflightResume = async (): Promise<boolean> => {
      if (state.sessionRef === null) {
        return true;
      }
      let reason: string | null = null;
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.session(state.sessionRef)}`, { headers: auth });
        if (!res.ok) {
          reason = `the session answered HTTP ${res.status}`;
        }
      } catch (error) {
        reason = String(error).slice(0, 200);
      }
      if (reason === null) {
        return true;
      }
      start.onEvent({ ts: nowIso(now), kind: 'error', text: `resume pre-flight failed — ${reason}` });
      start.onResumeFailed?.(reason);
      await server?.killTree();
      finish(-1);
      return false;
    };

    /**
     * T-0049 compact-first: the compaction runs as a turn of its own
     * (delivery `steer`, spike 2) — the `idle` marker in the message list
     * is the one signal it settled. No deadline: a local model may think
     * for minutes (ADR-0014); the owner's stop ends the run.
     */
    const compactBeforePrompt = async (): Promise<void> => {
      if (start.compactFirst !== true || state.sessionRef === null || address === '') {
        return;
      }
      const note = (text: string): void => {
        start.onEvent({ ts: nowIso(now), kind: 'note', text });
      };
      const startedAt = now().getTime();
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.compact(state.sessionRef)}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          note(`the pre-run compact failed (HTTP ${res.status}) — the session continues un-compacted`);
          return;
        }
      } catch (error) {
        note(`the pre-run compact failed — ${String(error).slice(0, 200)}`);
        return;
      }
      // The compact must complete before the instruction rides — and
      // before `lastPromptAt` exists, or the poll's `turnDone` would fire
      // on the compact's own idle marker and kill the worker before the
      // real turn starts (the T-0049 pitfall).
      for (;;) {
        if (!state.alive) {
          return;
        }
        try {
          const list = await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, { headers: auth });
          if (list.ok) {
            const body = (await list.json()) as { data?: OcMessage[] };
            const newest = (body.data ?? [])[0];
            if (newest !== undefined && newest.type === 'idle' && (newest.time?.created ?? 0) >= startedAt) {
              note('the resumed session was natively compacted before the first prompt');
              return;
            }
          }
        } catch {
          // retried by the next round
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    /** One poll round: cumulative usage + stream text + the turn's end. */
    const pollTurn = async (): Promise<void> => {
      if (!state.alive || state.sessionRef === null || address === '' || state.turnDone || state.usageBase === null) {
        return;
      }
      try {
        const res = await fetchFn(`${address}${OPENCODE_API.session(state.sessionRef)}`, { headers: auth });
        if (res.ok) {
          const body = (await res.json()) as { data?: OcSession };
          const s = body.data;
          if (s !== undefined) {
            reportUsage(sessionTotals(s));
          }
        }

        const list = await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, { headers: auth });
        if (list.ok) {
          const body = (await list.json()) as { data?: OcMessage[] };
          // The newest message says whether the worker stands (an idle
          // marker) or is mid-turn (anything after the last prompt).
          const newest = (body.data ?? [])[0];
          if (newest !== undefined) {
            const turn = newest.type === 'idle' ? 'idle' : 'busy';
            if (turn !== state.turn) {
              state.turn = turn;
              start.onEvent({ ts: nowIso(now), kind: 'usage', turn });
            }
          }
          /**
           * Whether a model message follows the newest prompt (req-80) —
           * read from the list's order, never from the server's clock.
           */
          let answered = true;
          // The API lists newest first; walk chronologically.
          for (const m of (body.data ?? []).slice().reverse()) {
            if (m.type === 'user') {
              answered = false;
            } else if (m.type === 'assistant') {
              answered = true;
            }
            if (m.type === 'assistant' && state.seenBeforeMs !== null && m.id !== undefined) {
              const settledAt = m.time?.completed ?? m.time?.created ?? 0;
              if (settledAt > 0 && settledAt <= state.seenBeforeMs) {
                state.seenAssistant.add(m.id);
                for (const part of m.content ?? []) {
                  if (part.type === 'tool' && part.id !== undefined) {
                    state.seenTools.add(part.id);
                  }
                }
              }
            }
            if (m.type === 'assistant') {
              if (m.tokens !== undefined) {
                state.contextTokens = (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0);
              }
              // A message's text and thinking are read once it is COMPLETE: the
              // list shows a message while it still streams, and reading it on
              // first sight lost most of what the worker said.
              let fresh = false;
              if ((m.time?.completed ?? 0) > 0 && m.id !== undefined && !state.seenAssistant.has(m.id)) {
                state.seenAssistant.add(m.id);
                fresh = true;
                const thought = (m.content ?? [])
                  .filter((part) => part.type === 'reasoning')
                  .map((part) => part.text ?? '')
                  .join('\n\n')
                  .trim();
                if (thought !== '') {
                  start.onEvent({ ts: nowIso(now), kind: 'note', text: `${THINK_PREFIX}${thought.slice(0, THINK_MAX)}` });
                }
                const text = messageText(m);
                if (text !== '') {
                  state.lastText = text;
                  // The subscription already streamed this message's text
                  // parts (sealed whole): emitting the joined text again
                  // would show the reply twice in the watch view. A
                  // degraded subscription (dropped mid-message) falls back
                  // to the polled text.
                  const sealed = sseParts.get(m.id)?.join('\n');
                  if (sealed !== text) {
                    start.onEvent({
                      ts: nowIso(now),
                      kind: 'text',
                      text: text.slice(0, 8_000),
                      activity: activityLine(text),
                      ...(state.contextTokens > 0 ? { contextTokens: state.contextTokens } : {}),
                    });
                  }
                }
              }
              // Every tool call is one visible step — shown once its input is
              // there (a call is listed first with an empty input, which read
              // as a bare "shell" / "read").
              for (const part of m.content ?? []) {
                const input = part.state?.input;
                const ready = input !== undefined && Object.keys(input).length > 0;
                if (part.type === 'tool' && part.id !== undefined && ready && !state.seenTools.has(part.id)) {
                  state.seenTools.add(part.id);
                  const activity = toolActivity(part.name, input);
                  start.onEvent({
                    ts: nowIso(now),
                    kind: 'note',
                    text: activity,
                    activity,
                    ...(part.name !== undefined ? { tool: part.name } : {}),
                    ...(state.contextTokens > 0 ? { contextTokens: state.contextTokens } : {}),
                  });
                }
              }
              // The message's own per-turn usage, once, AFTER its tool calls —
              // the session `tokens` are cumulative and never leave this
              // adapter as context size. Emitted under the same once-guard as
              // the text, so a 2 s poll cannot inflate the telemetry sums.
              if (fresh && m.tokens !== undefined) {
                start.onEvent({
                  ts: nowIso(now),
                  kind: 'usage',
                  turnUsage: {
                    input: m.tokens.input ?? null,
                    cacheRead: m.tokens.cache?.read ?? null,
                    cacheCreation: m.tokens.cache?.write ?? null,
                    output: m.tokens.output ?? null,
                  },
                });
              }
              if ((m.time?.completed ?? 0) > 0) {
                state.lastText = messageText(m) || state.lastText;
              }
            }
            // The server writes the turn's end into the list itself.
            if (m.type === 'idle' && (m.time?.created ?? 0) >= state.lastPromptAt && m.outcome === 'failed') {
              // The provider refused the turn (quota, rate limit, auth): the
              // worker did nothing, so there is no agent-done — the run fails
              // without a gate, never a red gate or a move on untouched code.
              if (!state.ended) {
                state.ended = true;
                start.onEvent({ ts: nowIso(now), kind: 'error', text: providerErrorText(m.error) });
                void killWorker();
              }
            } else if (m.type === 'idle' && (m.time?.created ?? 0) >= state.lastPromptAt && !answered && !state.held) {
              // A turn that ends without one model message is a refusal
              // the server did not mark failed (T-0061: three runs of 0
              // tokens, each gated on untouched code) — the same failure.
              if (!state.ended) {
                state.ended = true;
                start.onEvent({
                  ts: nowIso(now),
                  kind: 'error',
                  text: m.error !== undefined ? providerErrorText(m.error) : 'the provider answered the prompt with nothing — no model message, no tokens',
                });
                void killWorker();
              }
            } else if (m.type === 'idle' && (m.time?.created ?? 0) >= state.lastPromptAt) {
              // A turn that ends asking the owner (req-64) stands instead —
              // reported once, held or not, so the owner hears of it.
              const question = questionOf(state.lastText);
              if (question !== null && state.questionReportedFor !== state.lastPromptAt) {
                state.questionReportedFor = state.lastPromptAt;
                state.questionHold = true;
                const shaped = parseShapedQuestion(question);
                start.onEvent({
                  ts: nowIso(now),
                  kind: 'usage',
                  waiting: { kind: 'question', text: question, ...(shaped !== null ? { shaped } : {}) },
                });
              }
              if (!state.held && !state.questionHold) {
                state.turnDone = true;
              }
            }
          }
        }

        // A tool call the server wants approved blocks the turn silently:
        // the pending request becomes the run's wait (req-64).
        const pending = await fetchFn(`${address}${OPENCODE_API.permissions(state.sessionRef)}`, { headers: auth }).catch(
          () => null,
        );
        if (pending !== null && pending.ok) {
          const body = (await pending.json()) as { data?: ReadonlyArray<OcPermissionRequest> };
          const first = (body.data ?? []).find((r) => typeof r.id === 'string');
          if (first !== undefined && first.id !== state.permissionId) {
            state.permissionId = first.id!;
            start.onEvent({
              ts: nowIso(now),
              kind: 'usage',
              waiting: { kind: 'permission', text: permissionText(first), requestId: first.id! },
            });
          } else if (first === undefined && state.permissionId !== null) {
            state.permissionId = null;
            start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
          }
        }

        // The `question` tool asks through a form and blocks its call until
        // the form is answered — the turn neither ends nor goes on, so the
        // pending form becomes the run's wait, with its choices.
        const forms = await fetchFn(`${address}${OPENCODE_API.forms(state.sessionRef)}`, { headers: auth }).catch(() => null);
        if (forms !== null && forms.ok) {
          const body = (await forms.json()) as { data?: readonly OcForm[] };
          const form = (body.data ?? []).find((f) => typeof f.id === 'string' && (f.fields ?? []).length > 0);
          if (form !== undefined && form.id !== state.formId) {
            state.formId = form.id!;
            const questions = formQuestions(form);
            start.onEvent({
              ts: nowIso(now),
              kind: 'usage',
              waiting: { kind: 'question', text: formText(questions), requestId: form.id!, questions },
            });
          } else if (form === undefined && state.formId !== null) {
            state.formId = null;
            start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
          }
        }

        if (state.turnDone && !state.ended) {
          state.ended = true;
          start.onEvent({
            ts: nowIso(now),
            kind: 'result',
            text: state.lastText.slice(0, 8_000),
            tokensIn: state.tokensIn,
            tokensOut: state.tokensOut,
            cacheReadTokens: state.cacheReadTokens,
            ...(state.costUsd !== null ? { costUsd: state.costUsd } : {}),
          });
          // The turn is over — the fleet owns the worker process.
          void killWorker();
        }
        pollFailures = 0;
      } catch {
        // A dropped poll round is noise, the next one catches up — unless the
        // worker is attached (no process exit to tell us): then three in a
        // row mean its server is gone.
        pollFailures++;
        if (attached !== null && pollFailures >= 3) {
          finish(null);
        }
      }
    };

    const handle: WorkerHandle = {
      get pid(): number | null {
        return server?.pid ?? attached?.pid ?? null;
      },
      exited: new Promise<number | null>((resolve) => {
        exitResolve.current = resolve;
      }),
      steer: async (text) => {
        if (!state.alive || state.sessionRef === null || address === '') {
          return 'refused';
        }
        // While a turn is live the server queues the POST with delivery
        // `steer` — the native injection rung.
        state.lastPromptAt = now().getTime();
        if (state.questionHold) {
          // The owner answers the question: the next finished turn ends
          // the run again (unless the owner holds it), and the question
          // text is the past — it must not be asked a second time.
          state.questionHold = false;
          state.lastText = '';
          start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
        }
        const slash = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if (slash !== null && (await postCommand(slash[1]!, (slash[2] ?? '').trim()))) {
          return 'inject';
        }
        await postPrompt(text);
        return 'inject';
      },
      setHold: (held) => {
        state.held = held;
        if (!held && state.questionHold) {
          // Handed back unanswered: the standing turn ends the run.
          state.questionHold = false;
          start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
        }
      },
      answerPermission: async (requestId, decision) => {
        if (!state.alive || state.sessionRef === null || address === '') {
          return false;
        }
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.permissionReply(state.sessionRef, requestId)}`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ decision }),
          });
          if (!res.ok) {
            return false;
          }
        } catch {
          return false;
        }
        if (state.permissionId === requestId) {
          state.permissionId = null;
          start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
        }
        return true;
      },
      answerQuestion: async (formId, answers) => {
        if (!state.alive || state.sessionRef === null || address === '') {
          return false;
        }
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.formReply(state.sessionRef, formId)}`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ answer: answers }),
          });
          if (!res.ok) {
            return false;
          }
        } catch {
          return false;
        }
        if (state.formId === formId) {
          state.formId = null;
          start.onEvent({ ts: nowIso(now), kind: 'usage', waiting: null });
        }
        return true;
      },
      interrupt: async () => {
        if (!state.alive || state.sessionRef === null || address === '') {
          return false;
        }
        try {
          const res = await Promise.race([
            fetchFn(`${address}${OPENCODE_API.interrupt(state.sessionRef)}`, { method: 'POST', headers: auth }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), INTERRUPT_WAIT_MS)),
          ]);
          return res !== null && res.ok;
        } catch {
          return false;
        }
      },
      stop: async () => {
        if (state.sessionRef !== null && address !== '') {
          // The soft stop is a courtesy with a bound: a server that never
          // answers the interrupt must not keep the tree-kill from running
          // (an unbounded wait here let the runner's 10 s shutdown race
          // exit first and leave the worker alive, unsupervised).
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              fetchFn(`${address}${OPENCODE_API.interrupt(state.sessionRef)}`, { method: 'POST', headers: auth }),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, INTERRUPT_WAIT_MS);
              }),
            ]);
          } catch {
            // the tree-kill below is the guarantee
          } finally {
            clearTimeout(timer);
          }
        }
        await killWorker();
      },
    };

    if (attached !== null) {
      // A worker that outlived its runner: its server is up, its session
      // exists — only the polling and the handle are ours again.
      address = attached.address;
      auth = basicAuth(attached.password);
      state.sessionRef = attached.sessionRef;
      state.startedAt = attached.runStartedMs;
      state.lastPromptAt = attached.runStartedMs;
      start.onEvent({
        ts: nowIso(now),
        kind: 'note',
        text: `re-attached to the opencode server on ${attached.address}, session ${attached.sessionRef}`,
      });
      // Live parts and tool calls from here on; the poll keeps usage and the turn end.
      subscribeEvents();
      pollTimer = setInterval(() => void pollTurn(), 2_000);
      void loadCommands();
      void reportContextWindow();
      return handle;
    }

    // The server comes up asynchronously; the handle is live from the
    // start and every call reads through the closing-over state.
    void (async (): Promise<void> => {
      const port = await pickPort();
      address = `http://127.0.0.1:${port}`;
      const capConfig = opencodeCapConfig(start.model, start.contextCap ?? 0);
      server = spawnFn(
        'opencode',
        ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        { cwd: start.cwd, ...(capConfig !== null ? { env: { OPENCODE_CONFIG_CONTENT: capConfig } } : {}) },
      );
      if (capConfig !== null) {
        start.onEvent({
          ts: nowIso(now),
          kind: 'note',
          text: `context cap: ${Math.floor(start.contextCap!)} tokens — OpenCode compacts the session there`,
        });
      }
      server.onExit((code) => finish(code));

      // The server prints its credential on stdout:
      //   server password <token>
      const password = await new Promise<string>((resolve, reject) => {
        let buffer = '';
        let seen = false;
        const deadline = Date.now() + 60_000;
        const tick = setInterval(() => {
          if (seen) {
            clearInterval(tick);
          } else if (!state.alive) {
            clearInterval(tick);
            reject(new Error('opencode serve exited before printing the server password'));
          } else if (Date.now() > deadline) {
            clearInterval(tick);
            reject(new Error('opencode serve never printed the server password'));
          }
        }, 400);
        server?.onStdout((chunk) => {
          if (seen) {
            return;
          }
          buffer += chunk;
          let at = buffer.indexOf('\n');
          while (at >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            at = buffer.indexOf('\n');
            const match = /^server password (\S+)\s*$/.exec(line);
            if (match !== null) {
              seen = true;
              clearInterval(tick);
              resolve(match[1]!);
              return;
            }
          }
        });
      });
      auth = basicAuth(password);

      // GET /api/info answers once the services are up — the same ping
      // the official client's health check uses.
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (!state.alive) {
          await server.killTree();
          finish(null);
          return;
        }
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.info}`, { headers: auth });
          if (res.ok) {
            break;
          }
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) {
          throw new Error('opencode serve did not become ready in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!state.alive) {
        await server.killTree();
        finish(null);
        return;
      }

      // T-0049: a resumed session is verified before anything is
      // prompted — a missing session respawns the run fresh, never a
      // failed one.
      if (!(await preflightResume())) {
        return;
      }

      if (state.sessionRef === null) {
        const res = await fetchFn(`${address}${OPENCODE_API.createSession}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ title: `fleet ${start.ticketId}` }),
        });
        const body = (await res.json()) as { data?: { id?: string } };
        const id = body.data?.id;
        if (typeof id !== 'string') {
          throw new Error('opencode: session create returned no id');
        }
        state.sessionRef = id;
        start.onSessionRef(id);
      }
      start.onAttachInfo?.({ address, password, pid: server.pid > 0 ? server.pid : null });
      start.onEvent({
        ts: nowIso(now),
        kind: 'note',
        text: `opencode serve on 127.0.0.1:${port}, session ${state.sessionRef}`,
      });
      // Before the prompt: the resumed session's totals are its past only,
      // and so are its messages — a fresh adapter that read them again
      // replayed every old turn's usage into this run's telemetry (req-80).
      await readUsageBase();
      if (start.resumeRef !== null) {
        state.seenBeforeMs = now().getTime();
      }
      // Then, when asked, the native compact — it must settle BEFORE the
      // prompt and before the poll's `lastPromptAt` exists (T-0049).
      await compactBeforePrompt();
      state.startedAt = now().getTime();
      state.lastPromptAt = state.startedAt;

      subscribeEvents();
      pollTimer = setInterval(() => void pollTurn(), 2_000);
      await loadCommands();
      void reportContextWindow();

      // The prompt POST queues the turn and returns at once; the poll
      // The prompt POST queues the turn and returns at once; the poll
      // loop watches the message list for the `idle` end marker. A quiet
      // start (req-75) posts nothing — the worker stands until the
      // owner's first message opens the dialog; an empty instruction is
      // a resumed session that only stands (req-80) — holdAtSpawn now
      // covers it, the check stays as the invariant's guard.
      if (start.holdAtSpawn !== true && start.instruction !== '') {
        await postPrompt(start.instruction);
      }
    })().catch(async (error: unknown) => {
      if (state.alive) {
        start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 400) });
      }
      finish(-1);
      // A server that came up before the boot failed (not ready in time,
      // a refused prompt) is ours to end — finish() alone left it running.
      await server?.killTree().catch(() => undefined);
    });

    return handle;
  };

  return {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    promptless: true,
    spawn: (start) => build(start, null),
    attach: (start, info) => build(start, info),
  };
}

/** The fleet's provider table, fleet order = assignment default order. */
export function providerTable(spawnFn: SpawnFn, fetchFn: FetchFn = fetch): ProviderAdapter[] {
  return [opencodeAdapter(spawnFn, fetchFn), claudeCodeAdapter(spawnFn)];
}
