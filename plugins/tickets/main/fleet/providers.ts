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
import type { PermissionMode, RunUsage, SteerRung, WorkerProviderId } from './protocol';

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
  /**
   * Exactly one per assistant model call: THAT call's usage. The
   * providers' aggregates (`tokensIn`/`tokensOut`, the result event) are
   * cumulative over the run and must never pose as a turn's context.
   */
  readonly turnUsage?: RunUsage;
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
}

export interface ProviderAdapter {
  readonly id: WorkerProviderId;
  readonly label: string;
  /** True when steer reaches a live worker without ending it. */
  readonly liveInject: boolean;
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
      let busy = true;
      let inputClosed = false;
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
            start.onEvent({
              ts: nowIso(now),
              kind: 'result',
              text: (event.result ?? '').slice(0, 8_000),
              tokensIn,
              tokensOut,
              cacheReadTokens,
              ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}),
            });
            busy = false;
            start.onEvent({ ts: nowIso(now), kind: 'usage', turn: 'idle' });
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
      proc.write(userMessage(start.instruction));
      return {
        pid: proc.pid,
        exited: new Promise<number | null>((resolve) => proc.onExit(resolve)),
        steer: async (text) => {
          if (inputClosed) {
            return 'refused';
          }
          proc.write(userMessage(text));
          if (!busy) {
            busy = true;
            start.onEvent({ ts: nowIso(now), kind: 'usage', turn: 'busy' });
          }
          return 'inject';
        },
        setHold: (value) => {
          held = value;
          // Released while standing: nothing more is coming, the run ends.
          if (!held && !busy) {
            closeInput();
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
      turn: undefined as 'busy' | 'idle' | undefined,
      /** Idle markers older than this belong to an earlier turn. */
      lastPromptAt: 0,
      ended: false,
      seenAssistant: new Set<string>(),
      seenTools: new Set<string>(),
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
          // The API lists newest first; walk chronologically.
          for (const m of (body.data ?? []).slice().reverse()) {
            if (m.type === 'assistant' && attached !== null && m.id !== undefined) {
              const settledAt = m.time?.completed ?? m.time?.created ?? 0;
              if (settledAt > 0 && settledAt <= attached.seenBeforeMs) {
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
            if (m.type === 'idle' && !state.held && (m.time?.created ?? 0) >= state.lastPromptAt) {
              state.turnDone = true;
            }
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
        const slash = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if (slash !== null && (await postCommand(slash[1]!, (slash[2] ?? '').trim()))) {
          return 'inject';
        }
        await postPrompt(text);
        return 'inject';
      },
      setHold: (held) => {
        state.held = held;
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
      server = spawnFn(
        'opencode',
        ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        { cwd: start.cwd },
      );
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
      // Before the prompt: the resumed session's totals are its past only.
      await readUsageBase();
      state.startedAt = now().getTime();
      state.lastPromptAt = state.startedAt;

      subscribeEvents();
      pollTimer = setInterval(() => void pollTurn(), 2_000);
      await loadCommands();
      void reportContextWindow();

      // The prompt POST queues the turn and returns at once; the poll
      // loop watches the message list for the `idle` end marker.
      await postPrompt(start.instruction);
    })().catch((error: unknown) => {
      if (state.alive) {
        start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 400) });
      }
      finish(-1);
    });

    return handle;
  };

  return {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn: (start) => build(start, null),
    attach: (start, info) => build(start, info),
  };
}

/** The fleet's provider table, fleet order = assignment default order. */
export function providerTable(spawnFn: SpawnFn, fetchFn: FetchFn = fetch): ProviderAdapter[] {
  return [opencodeAdapter(spawnFn, fetchFn), claudeCodeAdapter(spawnFn)];
}
