import { describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter, modelBody, OPENCODE_API, opencodeAdapter, type FetchFn, type NormalizedEvent, type ProviderStart, INTERRUPT_WAIT_MS, toolActivity } from './providers';
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
  /** A finished assistant message as v2 writes it (flat, ms epoch times). */
  const assistant = (now: number): unknown => ({
    id: 'msg_a',
    type: 'assistant',
    time: { created: now + 1, completed: now + 2 },
    content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Done.' },
    ],
    tokens: { input: 8, output: 5 },
    cost: 0.01,
  });

  /** A scripted fetch: /api/info fails once, then everything answers. */
  function scriptedFetch(opts: {
    sessionCreated: (body: unknown) => void;
    prompts: string[];
    interrupts: string[];
    /** Messages newest-first, as the API lists them. */
    messages: () => unknown[];
    usage?: { tokens: { input: number; cache?: { read?: number }; output: number }; cost: number };
  }): { fetch: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let infoChecks = 0;
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const fetch: FetchFn = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith(OPENCODE_API.info)) {
        infoChecks += 1;
        return (infoChecks < 2
          ? { ok: false, status: 503 }
          : json({ version: '2.0.32' })) as Response;
      }
      if (url.endsWith(OPENCODE_API.createSession) && init?.method === 'POST') {
        opts.sessionCreated(JSON.parse(String(init.body)));
        return json({ data: { id: 'ses_oc' } });
      }
      if (url.endsWith(OPENCODE_API.prompt('ses_oc'))) {
        opts.prompts.push(String(init?.body));
        return json({ data: { id: 'msg_q', type: 'user', delivery: 'steer' } });
      }
      if (url.endsWith(OPENCODE_API.messages('ses_oc'))) {
        return json({ data: opts.messages(), cursor: { previous: null, next: null } });
      }
      if (url.endsWith(OPENCODE_API.session('ses_oc'))) {
        return json({ data: { tokens: opts.usage?.tokens ?? { input: 10, cache: { read: 4 }, output: 5 }, cost: opts.usage?.cost ?? 0.02 } });
      }
      if (url.endsWith(OPENCODE_API.interrupt('ses_oc'))) {
        opts.interrupts.push(url);
        return json({ interrupted: false });
      }
      return json({});
    };
    return { fetch, calls };
  }

  it('boots serve from the stdout password, creates the session, prompts it and reports usage', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const interrupts: string[] = [];
    let sessionBody: unknown;
    const { fetch } = scriptedFetch({
      sessionCreated: (body) => {
        sessionBody = body;
      },
      prompts,
      interrupts,
      messages: () => [],
    });
    const proc = fakeProcess();
    const { events, sessions, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);

    // Without the stdout credential line nothing is contacted yet.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessionBody).toBeUndefined();

    proc.stdout('server listening on http://127.0.0.1:47000');
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionBody).toEqual({ title: 'fleet T-0001' });
    expect(sessions).toEqual(['ses_oc']);
    expect(prompts[0]).toContain('Do the ticket.');

    // The usage poll lands within the interval (input + cache read).
    await vi.advanceTimersByTimeAsync(2_500);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage?.tokensIn).toBe(14);
    expect(usage?.tokensOut).toBe(5);
    expect(usage?.costUsd).toBe(0.02);

    const rung = await handle.steer('one more pass');
    expect(rung).toBe('inject');
    expect(prompts.at(-1)).toContain('one more pass');

    await handle.stop();
    expect(interrupts.length).toBe(1);
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('assistant text streams into the run log and the idle marker ends the turn', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const interrupts: string[] = [];
    const at = Date.now();
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts,
      interrupts,
      // Newest first — the idle marker above the assistant message.
      messages: () => [
        { id: 'msg_i', type: 'idle', time: { created: at + 5_000 }, outcome: 'succeeded' },
        assistant(at),
        { id: 'msg_q', type: 'user', time: { created: at }, text: 'Do the ticket.' },
      ],
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);

    await vi.advanceTimersByTimeAsync(0); // let the boot attach its stdout listener
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);

    const text = events.find((e) => e.kind === 'text');
    expect(text?.text).toBe('Done.');
    const result = events.find((e) => e.kind === 'result');
    expect(result?.text).toBe('Done.');
    expect(result?.tokensIn).toBe(14);
    expect(result?.tokensOut).toBe(5);
    expect(result?.costUsd).toBe(0.02);
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('stop interrupts the session and kills the serve process', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const interrupts: string[] = [];
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts,
      interrupts,
      messages: () => [],
    });
    const proc = fakeProcess();
    const { start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0); // let the boot attach its stdout listener
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_000);

    await handle.stop();
    expect(interrupts.length).toBe(1);
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('stop still kills the serve process when the interrupt never answers', async () => {
    vi.useFakeTimers();
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => [],
    });
    const hanging: FetchFn = (url, init) =>
      url.includes('/interrupt') ? new Promise<Response>(() => undefined) : fetch(url, init);
    const proc = fakeProcess();
    const { start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), hanging, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_000);

    const stopped = handle.stop();
    expect(proc.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS);
    await stopped;
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });
});

describe('modelBody — the OpenCode model pin (v2 shape)', () => {
  it('splits providerID/modelID at the first slash', () => {
    expect(modelBody('zai-coding-plan/glm-5.3-flash', 'go')).toEqual({
      text: 'go',
      model: { providerID: 'zai-coding-plan', modelID: 'glm-5.3-flash' },
    });
  });

  it('a pin without a slash rides as the modelID; no pin sends text only', () => {
    expect(modelBody('glm-5.3', 'go')).toEqual({ text: 'go', model: { providerID: '', modelID: 'glm-5.3' } });
    expect(modelBody(null, 'go')).toEqual({ text: 'go' });
  });
});

describe('toolActivity — the one line a tool call shows on the lane', () => {
  it('names the tool and its target', () => {
    expect(toolActivity('read', { path: 'src/a.ts' })).toBe('read src/a.ts');
    expect(toolActivity('shell', { command: 'git status --short' })).toBe('shell git status --short');
    expect(toolActivity('grep', { pattern: 'prepareWorktree' })).toBe('grep prepareWorktree');
  });

  it('copes with a call without input and caps a long target', () => {
    expect(toolActivity(undefined, undefined)).toBe('tool');
    expect(toolActivity('shell', { command: 'x'.repeat(400) }).length).toBeLessThanOrEqual(140);
  });
});
