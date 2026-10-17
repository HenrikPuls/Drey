import { describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter, OPENCODE_API, opencodeAdapter, type FetchFn, type NormalizedEvent, type ProviderStart } from './providers';
import type { RunnerProcess, SpawnFn } from './procs';

/**
 * The worker adapters against scripted node seams (no real CLIs): what
 * the owner's live spike rounds verify against installed binaries, the
 * specs pin as behavior.
 */

/** A scripted process: the spec pushes stdout lines, reads stdin writes. */
function fakeProcess(): RunnerProcess & {
  stdout: (line: string) => void;
  stdinWrites: string[];
  killTree: ReturnType<typeof vi.fn>;
  exit: (code: number | null) => void;
} {
  const listeners = {
    stdout: (_line: string): void => undefined,
    exit: (_code: number | null): void => undefined,
  };
  const stdinWrites: string[] = [];
  const killTree = vi.fn(async () => undefined);
  const proc: RunnerProcess & {
    stdout: (line: string) => void;
    stdinWrites: string[];
    killTree: typeof killTree;
    exit: (code: number | null) => void;
  } = {
    pid: 4242,
    write: (text) => {
      stdinWrites.push(text);
    },
    endInput: () => {
      stdinWrites.push('<<end>>');
    },
    onStdout: (cb) => {
      listeners.stdout = cb;
    },
    onStderr: () => undefined,
    onExit: (cb) => {
      listeners.exit = cb;
    },
    stdout: (line) => listeners.stdout(`${line}\n`),
    stdinWrites,
    killTree,
    exit: (code) => listeners.exit(code),
  };
  return proc;
}

const spawnOf = (proc: ReturnType<typeof fakeProcess>): SpawnFn => () => proc;

const collect = (overrides: Partial<ProviderStart> = {}) => {
  const events: NormalizedEvent[] = [];
  const sessions: string[] = [];
  const start: ProviderStart = {
    cwd: 'W:/kt',
    instruction: 'Do the ticket.',
    model: null,
    permissionMode: 'accept-edits',
    resumeRef: null,
    ticketId: 'T-0001',
    onEvent: (event) => events.push(event),
    onSessionRef: (ref) => sessions.push(ref),
    ...overrides,
  };
  return { events, sessions, start };
};

describe('the claude-code adapter', () => {
  it('spawns stream-json with the permission mode and feeds the instruction', async () => {
    const proc = fakeProcess();
    const { events, sessions, start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    expect(proc.stdinWrites[0]).toContain('"type":"user"');
    expect(proc.stdinWrites[0]).toContain('Do the ticket.');

    proc.stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses_1' }));
    proc.stdout(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 30 },
      total_cost_usd: 0.12,
      result: 'done',
    }));
    proc.exit(0);

    await expect(handle.exited).resolves.toBe(0);
    expect(sessions).toEqual(['ses_1']);
    const result = events.find((e) => e.kind === 'result');
    expect(result?.tokensIn).toBe(150);
    expect(result?.tokensOut).toBe(30);
    expect(result?.costUsd).toBe(0.12);
  });

  it('steer writes a user message into the held stdin (the injection rung)', async () => {
    const proc = fakeProcess();
    const { start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    const rung = await handle.steer('Change course');
    expect(rung).toBe('inject');
    expect(proc.stdinWrites.at(-1)).toContain('Change course');
  });

  it('a resume run carries --resume with the session ref', () => {
    const seen: string[][] = [];
    const spawnFn: SpawnFn = (_cmd, args) => {
      seen.push([...args]);
      return fakeProcess();
    };
    const { start } = collect({ resumeRef: 'ses_9' });
    claudeCodeAdapter(spawnFn).spawn(start);
    expect(seen[0]).toContain('--resume');
    expect(seen[0]).toContain('ses_9');
  });
});

describe('the opencode adapter', () => {
  /** A scripted fetch: health fails once, then everything answers. */
  function scriptedFetch(opts: {
    sessionCreated: (body: unknown) => void;
    prompts: string[];
  }): { fetch: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let healthChecks = 0;
    const fetch: FetchFn = async (url, init) => {
      const text = url;
      calls.push({ url: text, init });
      if (text.endsWith(OPENCODE_API.health)) {
        healthChecks += 1;
        return (healthChecks < 2 ? { ok: false, status: 503 } : { ok: true, status: 200 }) as Response;
      }
      if (text.endsWith(OPENCODE_API.createSession) && init?.method === 'POST') {
        opts.sessionCreated(JSON.parse(String(init.body)));
        return { ok: true, status: 200, json: async () => ({ id: 'ses_oc' }) } as unknown as Response;
      }
      if (text.endsWith(OPENCODE_API.messages('ses_oc'))) {
        if (init?.method === 'POST') {
          opts.prompts.push(String(init.body));
          return { ok: true, status: 200, text: async () => 'ok' } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => [{ info: { role: 'assistant', tokens: { input: 10, output: 5 }, cost: 0.02 } }],
        } as unknown as Response;
      }
      if (text.endsWith(OPENCODE_API.abort('ses_oc'))) {
        return { ok: true, status: 200 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };
    return { fetch, calls };
  }

  it('boots serve, creates the session, prompts it and reports usage', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    let sessionBody: unknown;
    const { fetch } = scriptedFetch({
      sessionCreated: (body) => {
        sessionBody = body;
      },
      prompts,
    });
    const proc = fakeProcess();
    const { events, sessions, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionBody).toEqual({ title: 'fleet T-0001' });
    expect(sessions).toEqual(['ses_oc']);
    expect(prompts[0]).toContain('Do the ticket.');

    // The usage poll lands within the interval.
    await vi.advanceTimersByTimeAsync(2_500);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage?.tokensIn).toBe(10);
    expect(usage?.tokensOut).toBe(5);
    expect(usage?.costUsd).toBe(0.02);

    const rung = await handle.steer('one more pass');
    expect(rung).toBe('inject');
    expect(prompts.at(-1)).toContain('one more pass');

    await handle.stop();
    await vi.advanceTimersByTimeAsync(0);
    proc.exit(0);
    vi.useRealTimers();
  });

  it('stop aborts the session and kills the serve process', async () => {
    vi.useFakeTimers();
    const aborts: string[] = [];
    const prompts: string[] = [];
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts,
    });
    // Patch abort capture.
    const fetchWithAbort: FetchFn = async (url, init) => {
      const text = url;
      if (text.endsWith(OPENCODE_API.abort('ses_oc'))) {
        aborts.push(text);
      }
      return fetch(url, init);
    };
    const proc = fakeProcess();
    const { start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetchWithAbort, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(1_000);

    await handle.stop();
    expect(aborts.length).toBe(1);
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });
});
