/**
 * The worker providers of milestone 84 (ADR-0075): one adapter per agent
 * CLI, each normalizing to the same handle — start, steer (the ladder's
 * best rung), stop, and normalized stream events for the run log.
 *
 * - `opencode` drives `opencode serve` (v2) bound to loopback and talks
 *   its HTTP API: a prompt POST into the running session is the native
 *   injection rung, `abort` the soft stop, and assistant messages carry
 *   tokens and cost for the Tickets panel footer. Progress is POLLED,
 *   not streamed — v1's event stream dropped mid-turn, and the runner
 *   must not care which generation it found.
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
            message?: { usage?: ClaudeUsage };
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
// opencode — v2 server API over loopback

/**
 * The v2 surface the adapter speaks. The owner's live spike round pins
 * these against the installed binary; they live here so correcting the
 * fleet is a one-file change.
 */
export const OPENCODE_API = {
  health: '/global/health',
  createSession: '/session',
  messages: (id: string): string => `/session/${id}/message`,
  abort: (id: string): string => `/session/${id}/abort`,
} as const;

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
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null as number | null,
        password: `fleet-${Math.random().toString(36).slice(2)}`,
        alive: true,
      };
      let server: RunnerProcess | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const exitResolve = { current: null as ((code: number | null) => void) | null };
      const finish = (code: number | null): void => {
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

      const pollUsage = async (): Promise<void> => {
        if (!state.alive || state.sessionRef === null || address === '') {
          return;
        }
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, { headers: auth });
          if (!res.ok) {
            return;
          }
          const messages = (await res.json()) as Array<{
            info?: { role?: string; tokens?: { input?: number; output?: number }; cost?: number };
          }>;
          for (const m of messages.slice().reverse()) {
            if (m.info?.role === 'assistant' && m.info.tokens !== undefined) {
              state.tokensIn = m.info.tokens.input ?? state.tokensIn;
              state.tokensOut = m.info.tokens.output ?? state.tokensOut;
              state.costUsd = m.info.cost ?? state.costUsd;
              start.onEvent({
                ts: nowIso(now),
                kind: 'usage',
                tokensIn: state.tokensIn,
                tokensOut: state.tokensOut,
                ...(state.costUsd !== null ? { costUsd: state.costUsd } : {}),
              });
              break;
            }
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
          try {
            await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
            });
            return 'inject';
          } catch {
            return 'refused';
          }
        },
        stop: async () => {
          state.alive = false;
          if (state.sessionRef !== null && address !== '') {
            try {
              await fetchFn(`${address}${OPENCODE_API.abort(state.sessionRef)}`, { method: 'POST', headers: auth });
            } catch {
              // the tree-kill below is the guarantee
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
        auth = { Authorization: `Bearer ${state.password}` };
        server = spawnFn(
          'opencode',
          ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--auto'],
          { cwd: start.cwd, env: { OPENCODE_SERVER_PASSWORD: state.password } },
        );
        server.onExit((code) => finish(code));

        // The server answers /global/health once its services are up.
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (!state.alive) {
            await server.killTree();
            finish(null);
            return;
          }
          try {
            const res = await fetchFn(`${address}${OPENCODE_API.health}`, { headers: auth });
            if (res.ok) {
              break;
            }
          } catch {
            // not up yet
          }
          if (Date.now() > deadline) {
            throw new Error('opencode serve did not become ready in time');
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
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
          const body = (await res.json()) as { id?: string };
          if (typeof body.id !== 'string') {
            throw new Error('opencode: session create returned no id');
          }
          state.sessionRef = body.id;
          start.onSessionRef(body.id);
        }
        start.onEvent({
          ts: nowIso(now),
          kind: 'note',
          text: `opencode serve on 127.0.0.1:${port}, session ${state.sessionRef}`,
        });

        pollTimer = setInterval(() => void pollUsage(), 2_000);

        // The prompt POST resolves when the turn completes — that IS the
        // run's lifecycle. A steer POST is queued by the server and lands
        // in the same session (the native injection rung).
        try {
          const res = await fetchFn(`${address}${OPENCODE_API.messages(state.sessionRef)}`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ text: start.instruction }),
          });
          const text = await res.text();
          if (!res.ok) {
            start.onEvent({
              ts: nowIso(now),
              kind: 'error',
              text: `prompt failed: ${res.status} ${text.slice(0, 300)}`,
            });
          }
        } catch (error) {
          if (state.alive) {
            start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 300) });
          }
        }
      })().catch((error: unknown) => {
        start.onEvent({ ts: nowIso(now), kind: 'error', text: String(error).slice(0, 400) });
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
