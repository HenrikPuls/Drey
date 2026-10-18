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
 *   footer. Progress is POLLED, not streamed — v1's event stream dropped
 *   mid-turn, and the runner must not care which generation it found; the
 *   message list's `idle` marker ends the turn.
 * - `claude-code` drives the CLI over stream-json: stdin is held open
 *   (`--input-format stream-json`), so injection writes a user message
 *   in; resume is `--resume <sessionRef>`.
 *
 * Both adapters take their node seams (spawn, fetch, port pick) through
 * the constructor — the specs run them against fakes, and the owner's
 * live spike rounds pin the exact CLI/API shapes.
 */
import { freePort, type RunnerProcess, type SpawnFn } from './procs';
import type { PermissionMode, SteerRung, WorkerProviderId } from './protocol';

/** One line of the run's normalized stream file (`stream.jsonl`). */
export interface NormalizedEvent {
  readonly ts: string;
  readonly kind: 'note' | 'text' | 'usage' | 'result' | 'error';
  readonly text?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  /** One short line: what the worker is doing now (a tool call, a text opening). */
  readonly activity?: string;
  /** The current context window's size in tokens. */
  readonly contextTokens?: number;
}

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
            message?: {
              usage?: ClaudeUsage;
              content?: ReadonlyArray<{ type?: string; name?: string; text?: string; input?: Record<string, unknown> }>;
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
            continue;
          }
          if (event.type === 'assistant' && event.message !== undefined) {
            // Every model call reports its own usage: the input side of
            // the latest one is the size of the context right now.
            const usage = event.message.usage;
            const contextTokens =
              usage === undefined
                ? undefined
                : (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            const parts = event.message.content ?? [];
            const tool = parts.find((p) => p.type === 'tool_use');
            const activity =
              tool !== undefined
                ? activityLine(
                    `${tool.name ?? 'tool'} ${String(tool.input?.['file_path'] ?? tool.input?.['command'] ?? tool.input?.['pattern'] ?? '')}`,
                  )
                : activityLine(parts.find((p) => p.type === 'text')?.text ?? '');
            if (contextTokens !== undefined || activity !== '') {
              start.onEvent({
                ts: nowIso(now),
                kind: 'usage',
                ...(contextTokens !== undefined ? { contextTokens } : {}),
                ...(activity !== '' ? { activity } : {}),
              });
            }
            continue;
          }
          if (event.type === 'result') {
            // The result event carries the run's cumulative usage.
            const usage: ClaudeUsage = event.usage ?? event.message?.usage ?? {};
            const tokensIn = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
            const tokensOut = usage.output_tokens ?? 0;
            start.onEvent({
              ts: nowIso(now),
              kind: 'result',
              text: (event.result ?? '').slice(0, 8_000),
              tokensIn,
              tokensOut,
              ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}),
            });
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
          proc.write(userMessage(text));
          return 'inject';
        },
        stop: async () => {
          proc.endInput();
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

interface OcSession {
  readonly cost?: number;
  readonly tokens?: OcUsage;
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
} as const;

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

/** How long a stop waits for the server's answer to the soft interrupt before it kills the tree. */
export const INTERRUPT_WAIT_MS = 3_000;

export function opencodeAdapter(
  spawnFn: SpawnFn,
  fetchFn: FetchFn = fetch,
  pickPort: () => Promise<number> = freePort,
  now: NowFn = (): Date => new Date(),
): ProviderAdapter {
  return {
    id: 'opencode',
    label: 'OpenCode',
    liveInject: true,
    spawn(start) {
      const state = {
        sessionRef: start.resumeRef,
        alive: true,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null as number | null,
        startedAt: 0,
        turnDone: false,
        /** A human drives the session: an idle marker is not the run's end. */
        held: false,
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

      const exitResolve = { current: null as ((code: number | null) => void) | null };
      let finished = false;
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

      /** Text of the message's `text` content parts, trimmed. */
      const messageText = (m: OcMessage): string =>
        (m.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
          .trim();

      /** One poll round: cumulative usage + stream text + the turn's end. */
      const pollTurn = async (): Promise<void> => {
        if (!state.alive || state.sessionRef === null || address === '' || state.turnDone) {
          return;
        }
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.session(state.sessionRef)}`, { headers: auth });
          if (res.ok) {
            const body = (await res.json()) as { data?: OcSession };
            const s = body.data;
            if (s !== undefined) {
              const tokensIn = (s.tokens?.input ?? 0) + (s.tokens?.cache?.read ?? 0);
              const tokensOut = s.tokens?.output ?? 0;
              const cost = s.cost ?? null;
              if (tokensIn !== state.tokensIn || tokensOut !== state.tokensOut || cost !== state.costUsd) {
                state.tokensIn = tokensIn;
                state.tokensOut = tokensOut;
                state.costUsd = cost;
                start.onEvent({
                  ts: nowIso(now),
                  kind: 'usage',
                  tokensIn,
                  tokensOut,
                  ...(cost !== null ? { costUsd: cost } : {}),
                });
              }
            }
          }

          const list = await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, { headers: auth });
          if (list.ok) {
            const body = (await list.json()) as { data?: OcMessage[] };
            // The API lists newest first; walk chronologically.
            for (const m of (body.data ?? []).slice().reverse()) {
              if (m.type === 'assistant') {
                if (m.tokens !== undefined) {
                  state.contextTokens = (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0);
                }
                if (m.id !== undefined && !state.seenAssistant.has(m.id)) {
                  state.seenAssistant.add(m.id);
                  const text = messageText(m);
                  if (text !== '') {
                    state.lastText = text;
                    start.onEvent({
                      ts: nowIso(now),
                      kind: 'text',
                      text: text.slice(0, 8_000),
                      activity: activityLine(text),
                      ...(state.contextTokens > 0 ? { contextTokens: state.contextTokens } : {}),
                    });
                  }
                }
                // Every tool call is one visible step: the lane shows what
                // the worker reads and runs, and a worker that only calls
                // tools no longer looks silent (and stalled).
                for (const part of m.content ?? []) {
                  if (part.type === 'tool' && part.id !== undefined && !state.seenTools.has(part.id)) {
                    state.seenTools.add(part.id);
                    const activity = toolActivity(part.name, part.state?.input);
                    start.onEvent({
                      ts: nowIso(now),
                      kind: 'note',
                      text: activity,
                      activity,
                      ...(state.contextTokens > 0 ? { contextTokens: state.contextTokens } : {}),
                    });
                  }
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
              ...(state.costUsd !== null ? { costUsd: state.costUsd } : {}),
            });
            // The turn is over — the fleet owns the worker process.
            void server?.killTree();
          }
        } catch {
          // a dropped poll round is noise; the next one catches up
        }
      };

      const handle: WorkerHandle = {
        get pid(): number | null {
          return server?.pid ?? null;
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
          await server?.killTree();
        },
      };

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
        // v2 speaks HTTP BASIC with the fixed user `opencode`.
        auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };

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
        start.onEvent({
          ts: nowIso(now),
          kind: 'note',
          text: `opencode serve on 127.0.0.1:${port}, session ${state.sessionRef}`,
        });
        state.startedAt = now().getTime();
        state.lastPromptAt = state.startedAt;

        pollTimer = setInterval(() => void pollTurn(), 2_000);

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
    },
  };
}

/** The fleet's provider table, fleet order = assignment default order. */
export function providerTable(spawnFn: SpawnFn, fetchFn: FetchFn = fetch): ProviderAdapter[] {
  return [opencodeAdapter(spawnFn, fetchFn), claudeCodeAdapter(spawnFn)];
}
