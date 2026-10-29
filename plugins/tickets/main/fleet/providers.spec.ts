import { describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter, modelBody, OPENCODE_API, opencodeAdapter, type FetchFn, type NormalizedEvent, type ProviderStart, INTERRUPT_WAIT_MS, toolActivity } from './providers';
import { telemetryFromEvents } from './telemetry';
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

  it('writes thinking, replies and tool calls into the transcript', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 10, cache_read_input_tokens: 5 },
        content: [
          { type: 'thinking', thinking: 'Look at the file first.' },
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
        ],
      },
    }));
    expect(events.map((e) => [e.kind, e.text ?? ''])).toEqual([
      ['note', 'thinking › Look at the file first.'],
      ['text', 'Reading it now.'],
      ['note', 'Read src/a.ts'],
      ['usage', ''],
    ]);
    expect(events.at(-1)?.contextTokens).toBe(15);
  });

  it('writes a tool result as an outcome note', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'line one\nline two' }] } }));
    expect(events.map((e) => e.text)).toEqual(['result › line one']);
  });

  it('steer writes a user message into the held stdin (the injection rung)', async () => {
    const proc = fakeProcess();
    const { start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    const rung = await handle.steer('Change course');
    expect(rung).toBe('inject');
    expect(proc.stdinWrites.at(-1)).toContain('Change course');
  });

  it('reports the slash commands the CLI lists at init', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses_1', slash_commands: ['compact', '/cost'] }));
    expect(events.find((e) => e.commands !== undefined)?.commands).toEqual(['compact', 'cost']);
  });

  it('a finished turn closes the input unless the owner holds the worker', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'done' }));
    expect(proc.stdinWrites.at(-1)).toBe('<<end>>');
    expect(events.at(-1)).toMatchObject({ kind: 'usage', turn: 'idle' });
  });

  it('a held worker stays open, takes another prompt and ends on release', async () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    handle.setHold?.(true);
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'done' }));
    expect(proc.stdinWrites).not.toContain('<<end>>');

    expect(await handle.steer('One more thing')).toBe('inject');
    expect(proc.stdinWrites.at(-1)).toContain('One more thing');
    expect(events.at(-1)).toMatchObject({ kind: 'usage', turn: 'busy' });

    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'again' }));
    handle.setHold?.(false);
    expect(proc.stdinWrites.at(-1)).toBe('<<end>>');
    expect(await handle.steer('too late')).toBe('refused');
  });

  it('interrupt sends the control request only while a turn is running', async () => {
    const proc = fakeProcess();
    const { start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    handle.setHold?.(true);
    expect(await handle.interrupt?.()).toBe(true);
    const written = JSON.parse(proc.stdinWrites.at(-1)!) as { type: string; request: { subtype: string } };
    expect(written.type).toBe('control_request');
    expect(written.request.subtype).toBe('interrupt');
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'interrupted' }));
    expect(await handle.interrupt?.()).toBe(false);
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

  it('emits one turnUsage per assistant call — telemetry sums turns, never the cumulative result', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 900, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 4_000, output_tokens: 210 },
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }],
      },
    }));
    proc.stdout(JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 1_100, cache_read_input_tokens: 30_000, output_tokens: 300 },
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }],
      },
    }));
    // The CLI's result carries the run's CUMULATIVE usage.
    proc.stdout(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 52_000, cache_read_input_tokens: 50_000, output_tokens: 510 },
      result: 'done',
    }));
    const t = telemetryFromEvents(events);
    expect(t.turns).toBe(2);
    expect(t.usage).toEqual({ input: 2_000, cacheRead: 50_000, cacheCreation: 4_000, output: 510 });
    expect(t.lastTurnContext).toBe(31_100); // the LAST turn only — not the 102_000 aggregate
    expect(t.tokensBeforeFirstWrite).toBe(24_900); // the Edit's turn no longer counts
    expect(t.readCalls).toBe(1);
    expect(events.find((e) => e.text === 'Read src/a.ts')?.tool).toBe('Read');
    expect(events.find((e) => e.text === 'Edit src/a.ts')?.tool).toBe('Edit');
  });

  it('an assistant event without a usage block omits turnUsage entirely (no zeros)', () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'No usage here.' }] },
    }));
    expect(events.some((e) => e.kind === 'usage')).toBe(true); // the activity line still lands
    expect(events.filter((e) => e.turnUsage !== undefined)).toHaveLength(0);
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
    const usage = events.find((e) => e.kind === 'usage' && e.tokensIn !== undefined);
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

  it('lists its slash commands and runs a known one as a command, not as text', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const posted: Array<{ url: string; body: string }> = [];
    const { fetch: base } = scriptedFetch({ sessionCreated: () => undefined, prompts, interrupts: [], messages: () => [] });
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const fetch: FetchFn = async (url, init) => {
      if (url.endsWith(OPENCODE_API.commands)) {
        return json({ data: [{ name: 'deploy' }] });
      }
      if (url.endsWith(OPENCODE_API.compact('ses_oc')) || url.endsWith(OPENCODE_API.command('ses_oc'))) {
        posted.push({ url, body: String(init?.body) });
        return json({ data: {} });
      }
      return base(url, init);
    };
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(100);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.find((e) => e.commands !== undefined)?.commands).toEqual(['compact', 'deploy']);

    await handle.steer('/compact');
    await handle.steer('/deploy staging now');
    await handle.steer('/nosuch thing');
    expect(posted.map((p) => p.url.split('/').at(-1))).toEqual(['compact', 'command']);
    expect(JSON.parse(posted[1]!.body)).toEqual({ name: 'deploy', text: 'staging now' });
    expect(prompts.at(-1)).toContain('/nosuch thing');

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

  it('a held run ignores the idle marker until it is released, and interrupt posts to the server', async () => {
    vi.useFakeTimers();
    const interrupts: string[] = [];
    const at = Date.now();
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts,
      messages: () => [
        { id: 'msg_i', type: 'idle', time: { created: at + 5_000 }, outcome: 'interrupted' },
        assistant(at),
        { id: 'msg_q', type: 'user', time: { created: at }, text: 'Do the ticket.' },
      ],
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    handle.setHold?.(true);

    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(events.find((e) => e.kind === 'result')).toBeUndefined();
    expect(proc.killTree).not.toHaveBeenCalled();

    expect(await handle.interrupt?.()).toBe(true);
    expect(interrupts.length).toBe(1);

    handle.setHold?.(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(events.find((e) => e.kind === 'result')).toBeDefined();
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('reads a message only once it is complete and shows a tool call only with its input', async () => {
    vi.useFakeTimers();
    const at = Date.now();
    let round = 0;
    const streaming = {
      id: 'msg_s',
      type: 'assistant',
      time: { created: at + 1 },
      content: [
        { type: 'reasoning', text: 'Let me look.' },
        { type: 'tool', id: 'call_1', name: 'read', state: { status: 'pending', input: {} } },
      ],
    };
    const finished = {
      ...streaming,
      time: { created: at + 1, completed: at + 3 },
      content: [
        { type: 'reasoning', text: 'Let me look.' },
        { type: 'text', text: 'Found it.' },
        { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'src/a.ts' } } },
      ],
    };
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => (round++ < 2 ? [streaming] : [finished]),
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_100);
    expect(events.filter((e) => e.kind === 'note' && e.text === 'read')).toHaveLength(0);
    expect(events.find((e) => e.kind === 'text')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(events.filter((e) => e.text === 'read src/a.ts')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'text')?.text).toBe('Found it.');
    expect(events.find((e) => e.text === 'thinking › Let me look.')).toBeDefined();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('attach binds to a running server: nothing is spawned, streamed messages stay out, the idle marker ends the turn through the attach kill', async () => {
    vi.useFakeTimers();
    const at = Date.now();
    const earlier = {
      ...(assistant(at - 100_000) as object),
      id: 'msg_old',
      content: [{ type: 'text', text: 'earlier text' }],
    };
    const { fetch, calls } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => [
        { id: 'msg_i', type: 'idle', time: { created: at + 5_000 }, outcome: 'succeeded' },
        { ...(assistant(at) as object), id: 'msg_new' },
        earlier,
      ],
    });
    const kill = vi.fn(async () => undefined);
    const spawn = vi.fn();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawn as unknown as SpawnFn, fetch, async () => 47000).attach!(start, {
      address: 'http://127.0.0.1:50001',
      password: 'pw',
      sessionRef: 'ses_oc',
      runStartedMs: at - 200_000,
      seenBeforeMs: at - 1_000,
      pid: 777,
      kill,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(spawn).not.toHaveBeenCalled();
    expect(calls[0]?.url.startsWith('http://127.0.0.1:50001')).toBe(true);
    expect((calls[0]?.init?.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
    );
    expect(events.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['Done.']);
    expect(events.find((e) => e.kind === 'result')).toBeDefined();
    expect(kill).toHaveBeenCalled();
    expect(await handle.exited).toBeNull();
    expect(handle.pid).toBe(777);
    vi.useRealTimers();
  });

  it('an attached worker whose server stops answering ends after three failed polls; stop uses the attach kill', async () => {
    vi.useFakeTimers();
    const failing: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const attachInfo = (kill: () => Promise<void>) => ({
      address: 'http://127.0.0.1:50001',
      password: 'pw',
      sessionRef: 'ses_oc',
      runStartedMs: Date.now(),
      seenBeforeMs: 0,
      pid: 777,
      kill,
    });
    const { start } = collect();
    const adapter = opencodeAdapter(vi.fn() as unknown as SpawnFn, failing, async () => 47000);

    const gone = adapter.attach!(start, attachInfo(async () => undefined));
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(gone.exited).resolves.toBeNull();

    const kill = vi.fn(async () => undefined);
    const stopping = adapter.attach!(start, attachInfo(kill));
    await stopping.stop();
    expect(kill).toHaveBeenCalledTimes(1);
    await expect(stopping.exited).resolves.toBeNull();
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

  it('emits turnUsage once per completed message — telemetry sums turns, never the session aggregate', async () => {
    vi.useFakeTimers();
    const at = Date.now();
    const first = {
      id: 'msg_1',
      type: 'assistant',
      time: { created: at + 1, completed: at + 2 },
      content: [{ type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'src/a.ts' } } }],
      tokens: { input: 700, cache: { read: 12_000 }, output: 200 },
    };
    const second = {
      id: 'msg_2',
      type: 'assistant',
      time: { created: at + 3, completed: at + 4 },
      content: [{ type: 'tool', id: 'call_2', name: 'write', state: { status: 'completed', input: { path: 'src/b.ts' } } }],
      tokens: { input: 800, cache: { read: 30_000, write: 900 }, output: 400 },
    };
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      // Newest first, as the API lists them; the session usage is CUMULATIVE.
      messages: () => [second, first],
      usage: { tokens: { input: 31_500, cache: { read: 42_000 }, output: 600 }, cost: 0.05 },
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);

    const t = telemetryFromEvents(events);
    expect(t.turns).toBe(2);
    expect(t.usage).toEqual({ input: 1_500, cacheRead: 42_000, cacheCreation: 900, output: 600 });
    expect(t.lastTurnContext).toBe(800 + 30_000 + 900); // the last message, not the session's sum
    expect(t.tokensBeforeFirstWrite).toBe(12_700); // the write's own turn no longer counts
    expect(t.readCalls).toBe(1);
    expect(events.find((e) => e.text === 'read src/a.ts')?.tool).toBe('read');
    expect(events.find((e) => e.text === 'write src/b.ts')?.tool).toBe('write');

    // The 2 s poll re-reads the list: the once-guard must hold, or the sums inflate.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(telemetryFromEvents(events).turns).toBe(2);

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
