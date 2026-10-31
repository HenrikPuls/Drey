import { describe, expect, it, vi } from 'vitest';
import { answersFromText, answersText, claudeCodeAdapter, formText, modelBody, OPENCODE_API, opencodeAdapter, permissionText, questionOf, type FetchFn, type NormalizedEvent, type ProviderStart, INTERRUPT_WAIT_MS, toolActivity } from './providers';
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
  // Multiple listeners, like the real child's `once('exit')` (T-0049:
  // the resume-failure report registers a second one).
  const exitListeners: Array<(code: number | null) => void> = [];
  const listeners = {
    stdout: (_line: string): void => undefined,
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
      exitListeners.push(cb);
    },
    stdout: (line) => listeners.stdout(`${line}\n`),
    stdinWrites,
    killTree,
    exit: (code) => {
      for (const cb of [...exitListeners]) {
        cb(code);
      }
    },
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
    expect(result?.cacheReadTokens).toBe(50);
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

  it('a result that asks QUESTION: keeps the input open and waits; the answer lets the next result end it (req-64)', async () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.stdout(JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 2 }, result: 'QUESTION: Which one, A or B?' }));
    expect(events.find((e) => e.kind === 'result')).toBeUndefined();
    expect(events.find((e) => e.waiting !== undefined)?.waiting).toEqual({ kind: 'question', text: 'Which one, A or B?' });
    expect(proc.stdinWrites).not.toContain('<<end>>');

    expect(await handle.steer('A')).toBe('inject');
    expect(events.at(-1)).toMatchObject({ turn: 'busy', waiting: null });
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'Done with A.' }));
    expect(events.find((e) => e.kind === 'result')?.text).toBe('Done with A.');
    expect(proc.stdinWrites.at(-1)).toBe('<<end>>');
  });

  it('a QUESTION: turn in the fixed shape carries it parsed (req-75 W2)', async () => {
    const proc = fakeProcess();
    const { events, start } = collect();
    claudeCodeAdapter(spawnOf(proc)).spawn(start);
    const shaped = [
      'QUESTION: Which database?',
      'Ticket: the store',
      'Where: step 1',
      'Why: undecided',
      'Options:',
      '1. SQLite — no server, fine locally',
      '2. Postgres — one server for all',
      'Recommendation: 1 — local first',
    ].join('\n');
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: shaped }));
    const waiting = events.find((e) => e.waiting !== undefined)?.waiting;
    expect(waiting).toMatchObject({
      kind: 'question',
      text: 'Which database?\nTicket: the store\nWhere: step 1\nWhy: undecided\nOptions:\n1. SQLite — no server, fine locally\n2. Postgres — one server for all\nRecommendation: 1 — local first',
      shaped: {
        question: 'Which database?',
        context: 'the store',
        where: 'step 1',
        why: 'undecided',
        options: [
          { n: 1, label: 'SQLite', consequence: 'no server, fine locally' },
          { n: 2, label: 'Postgres', consequence: 'one server for all' },
        ],
        recommended: 1,
        recommendationWhy: 'local first',
      },
    });
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

  it('compact-first routes /compact natively and waits for its result before the instruction (T-0049)', () => {
    const proc = fakeProcess();
    const { events, start } = collect({ resumeRef: 'ses_9', compactFirst: true });
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    expect(proc.stdinWrites[0]).toContain('/compact');
    expect(proc.stdinWrites.join('\n')).not.toContain('Do the ticket.');

    proc.stdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses_9' }));
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'compacted' }));
    // The compact's result is not the run's end: the input stays open
    // and the instruction follows as its own turn.
    expect(proc.stdinWrites.at(-1)).toContain('Do the ticket.');
    expect(proc.stdinWrites).not.toContain('<<end>>');
    expect(events.at(-1)).toMatchObject({ kind: 'usage', turn: 'busy' });

    // …and the instruction's result ends the turn as usual.
    proc.stdout(JSON.stringify({ type: 'result', usage: {}, result: 'done' }));
    expect(proc.stdinWrites.at(-1)).toBe('<<end>>');
    proc.exit(0);
  });

  it('a resumed CLI that exits before its init reports the failed resume — a fresh one does not (T-0049)', async () => {
    const proc = fakeProcess();
    const failures: string[] = [];
    const { start } = collect({ resumeRef: 'ses_gone', onResumeFailed: (reason) => failures.push(reason) });
    const handle = claudeCodeAdapter(spawnOf(proc)).spawn(start);
    proc.exit(1);
    await expect(handle.exited).resolves.toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('before its session was established');

    const freshProc = fakeProcess();
    const freshFailures: string[] = [];
    const { start: freshStart } = collect({ onResumeFailed: (reason) => freshFailures.push(reason) });
    const freshHandle = claudeCodeAdapter(spawnOf(freshProc)).spawn(freshStart);
    freshProc.exit(1);
    await expect(freshHandle.exited).resolves.toBe(1);
    expect(freshFailures).toHaveLength(0);
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
    /** Pending permission requests (req-64). */
    permissions?: () => unknown[];
    /** Recorded permission replies: [requestId, body]. */
    replies?: Array<[string, unknown]>;
    /** Pending question forms (OpenCode's `question` tool). */
    forms?: () => unknown[];
    /** Recorded form replies: [formId, body]. */
    formReplies?: Array<[string, unknown]>;
    /** The `/api/event` SSE response; default: a bodyless 200 the adapter must survive. */
    eventStream?: () => Response;
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
      if (url.endsWith(OPENCODE_API.event)) {
        return opts.eventStream !== undefined ? opts.eventStream() : json({});
      }
      if (url.endsWith(OPENCODE_API.createSession) && init?.method === 'POST') {
        opts.sessionCreated(JSON.parse(String(init.body)));
        return json({ data: { id: 'ses_oc' } });
      }
      if (url.endsWith(OPENCODE_API.prompt('ses_oc'))) {
        opts.prompts.push(String(init?.body));
        return json({ data: { id: 'msg_q', type: 'user', delivery: 'steer' } });
      }
      if (url.endsWith(OPENCODE_API.permissions('ses_oc'))) {
        return json({ data: opts.permissions?.() ?? [] });
      }
      if (url.endsWith(OPENCODE_API.forms('ses_oc'))) {
        return json({ data: opts.forms?.() ?? [] });
      }
      const formReply = /\/form\/([^/]+)\/reply$/.exec(url);
      if (formReply !== null && init?.method === 'POST') {
        opts.formReplies?.push([decodeURIComponent(formReply[1]!), JSON.parse(String(init.body))]);
        return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
      }
      const reply = /\/permission\/([^/]+)\/reply$/.exec(url);
      if (reply !== null && init?.method === 'POST') {
        opts.replies?.push([decodeURIComponent(reply[1]!), JSON.parse(String(init.body))]);
        return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
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
    expect(usage?.cacheReadTokens).toBe(4);
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

  it('holdAtSpawn boots, creates the session and starts the poll — but posts no prompt (req-75)', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const interrupts: string[] = [];
    const { fetch } = scriptedFetch({ sessionCreated: () => undefined, prompts, interrupts, messages: () => [] });
    const proc = fakeProcess();
    const { events, sessions, start } = collect({ holdAtSpawn: true });
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);

    await vi.advanceTimersByTimeAsync(100);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_000);
    // The worker is up, its session exists and is reported — the quiet
    // start delivers nothing: the worker stands until steered.
    expect(sessions).toEqual(['ses_oc']);
    expect(prompts).toEqual([]);

    // The poll runs as usual (usage lands), and the owner's first steer
    // is the session's first prompt.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(events.find((e) => e.kind === 'usage' && e.tokensIn !== undefined)?.tokensIn).toBe(14);
    await handle.steer('The owner starts the dialog');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('The owner starts the dialog');

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

  it('a turn that ends with QUESTION: waits instead of ending; the answer lets the next turn end the run (req-64)', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const at = Date.now();
    let messages: unknown[] = [
      { id: 'msg_i', type: 'idle', time: { created: at + 5_000 }, outcome: 'succeeded' },
      {
        id: 'msg_a',
        type: 'assistant',
        time: { created: at + 1, completed: at + 2 },
        content: [{ type: 'text', text: 'QUESTION: Which API — v1 or v2?' }],
      },
    ];
    const { fetch } = scriptedFetch({ sessionCreated: () => undefined, prompts, interrupts: [], messages: () => messages });
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(12_500);

    const waits = events.filter((e) => e.waiting !== undefined);
    expect(waits).toEqual([expect.objectContaining({ waiting: { kind: 'question', text: 'Which API — v1 or v2?' } })]);
    expect(events.find((e) => e.kind === 'result')).toBeUndefined();
    expect(proc.killTree).not.toHaveBeenCalled();

    await handle.steer('v2');
    expect(events.at(-1)).toMatchObject({ kind: 'usage', waiting: null });
    expect(prompts.at(-1)).toContain('v2');
    messages = [
      { id: 'msg_i2', type: 'idle', time: { created: Date.now() + 5_000 }, outcome: 'succeeded' },
      {
        id: 'msg_b',
        type: 'assistant',
        time: { created: Date.now() + 1, completed: Date.now() + 2 },
        content: [{ type: 'text', text: 'Done with v2.' }],
      },
      ...messages,
    ];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(events.find((e) => e.kind === 'result')?.text).toBe('Done with v2.');
    expect(proc.killTree).toHaveBeenCalled();
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a QUESTION: turn in the fixed shape carries it parsed (req-75 W2)', async () => {
    vi.useFakeTimers();
    const shaped = [
      'QUESTION: Should dragging a heading also move the text below it?',
      'Ticket: Outline — drag headings to reorder the note.',
      'Where: step 2 of 4, the drop handler; step 1 is green.',
      'Why: the plan says "reorder headings" but not whether the section body moves.',
      'Options:',
      '1. Move the whole section — one undo step, what other editors do',
      '2. Only the heading line — the text stays, structure usually breaks',
      'Recommendation: 1 — it keeps the note\'s structure intact.',
    ].join('\n');
    const at = Date.now();
    const messages: unknown[] = [
      { id: 'msg_i', type: 'idle', time: { created: at + 5_000 }, outcome: 'succeeded' },
      { id: 'msg_a', type: 'assistant', time: { created: at + 1, completed: at + 2 }, content: [{ type: 'text', text: shaped }] },
    ];
    const { fetch } = scriptedFetch({ sessionCreated: () => undefined, prompts: [], interrupts: [], messages: () => messages });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(12_500);

    const waiting = events.find((e) => e.waiting !== undefined)?.waiting;
    expect(waiting).toMatchObject({
      kind: 'question',
      shaped: {
        question: 'Should dragging a heading also move the text below it?',
        recommended: 1,
        options: [
          { n: 1, label: 'Move the whole section' },
          { n: 2, label: 'Only the heading line' },
        ],
      },
    });
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a pending permission request becomes the wait; the answer posts the decision and clears it (req-64)', async () => {
    vi.useFakeTimers();
    let pending: unknown[] = [{ id: 'per_1', sessionID: 'ses_oc', action: 'bash', resources: ['rm -rf dist'] }];
    const replies: Array<[string, unknown]> = [];
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => [],
      permissions: () => pending,
      replies,
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.filter((e) => e.waiting !== undefined)).toEqual([
      expect.objectContaining({ waiting: { kind: 'permission', text: 'bash rm -rf dist', requestId: 'per_1' } }),
    ]);

    expect(await handle.answerPermission?.('per_1', 'once')).toBe(true);
    expect(replies).toEqual([['per_1', { decision: 'once' }]]);
    expect(events.at(-1)).toMatchObject({ waiting: null });
    pending = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.filter((e) => e.waiting !== undefined)).toHaveLength(2);
    await handle.stop();
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a pending question form becomes the wait with its choices; the answer replies to the form and clears it', async () => {
    vi.useFakeTimers();
    let pending: unknown[] = [
      {
        id: 'frm_1',
        sessionID: 'ses_oc',
        title: 'Questions',
        metadata: { kind: 'question' },
        fields: [
          {
            key: 'q0',
            title: 'Merge',
            description: 'How should I merge?',
            type: 'string',
            options: [
              { value: 'Rebase', label: 'Rebase', description: 'linear history' },
              { value: 'Merge', label: 'Merge' },
            ],
            custom: true,
          },
        ],
      },
    ];
    const formReplies: Array<[string, unknown]> = [];
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => [],
      forms: () => pending,
      formReplies,
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.filter((e) => e.waiting !== undefined)).toEqual([
      expect.objectContaining({
        waiting: {
          kind: 'question',
          text: 'How should I merge?',
          requestId: 'frm_1',
          questions: [
            {
              key: 'q0',
              header: 'Merge',
              question: 'How should I merge?',
              options: [{ label: 'Rebase', description: 'linear history' }, { label: 'Merge' }],
              multiple: false,
            },
          ],
        },
      }),
    ]);

    expect(await handle.answerQuestion?.('frm_1', { q0: 'Rebase' })).toBe(true);
    expect(formReplies).toEqual([['frm_1', { answer: { q0: 'Rebase' } }]]);
    expect(events.at(-1)).toMatchObject({ waiting: null });
    pending = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.filter((e) => e.waiting !== undefined)).toHaveLength(2);
    await handle.stop();
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

    proc.exit(null);
    vi.useRealTimers();
  });

  /** A scripted SSE channel: the spec pushes `{type, data}` objects as `data:` lines. */
  function sseChannel(): { response: Response; push: (event: unknown) => void; end: () => void } {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const encoder = new TextEncoder();
    return {
      response: { ok: true, status: 200, body: stream } as unknown as Response,
      push: (event) => controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`)),
      end: () => controller?.close(),
    };
  }

  const ev = (type: string, data: object): unknown => ({ type, data: { sessionID: 'ses_oc', ...data } });

  it('streams tool calls and text parts live from the event subscription (T-0051)', async () => {
    vi.useFakeTimers();
    const channel = sseChannel();
    const at = Date.now();
    let round = 0;
    // After the events below, the list shows the finished message + idle marker.
    const finished = {
      id: 'msg_s',
      type: 'assistant',
      time: { created: at + 1, completed: at + 9 },
      content: [
        { type: 'text', text: 'Found it.' },
        { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'src/a.ts' } } },
      ],
    };
    const { fetch, calls } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => (round++ < 3 ? [] : [{ id: 'msg_i', type: 'idle', time: { created: at + 10_000 } }, finished]),
      eventStream: () => channel.response,
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls.some((c) => c.url.endsWith(OPENCODE_API.event))).toBe(true);

    channel.push(ev('session.tool.input.started', { assistantMessageID: 'msg_s', id: 'call_1', name: 'read' }));
    channel.push(ev('session.tool.called', { assistantMessageID: 'msg_s', id: 'call_1', input: { path: 'src/a.ts' } }));
    channel.push(
      ev('session.tool.success', { assistantMessageID: 'msg_s', id: 'call_1', content: [{ type: 'text', text: '42 lines' }] }),
    );
    channel.push(ev('session.text.delta', { assistantMessageID: 'msg_s', ordinal: 0, delta: 'Found ' }));
    channel.push(ev('session.text.delta', { assistantMessageID: 'msg_s', ordinal: 0, delta: '(mid-part, throttled)' }));
    channel.push(ev('session.text.ended', { assistantMessageID: 'msg_s', ordinal: 0, text: 'Found it.' }));
    await vi.advanceTimersByTimeAsync(0);

    const tools = events.filter((e) => e.kind === 'tool');
    expect(tools.map((e) => [e.tool, e.detail])).toEqual([
      ['read', 'running'],
      ['read', undefined],
      ['read', 'done'],
    ]);
    expect(tools[1]?.text).toBe('read src/a.ts');
    expect(tools[1]?.activity).toBe('read src/a.ts');
    expect(tools[2]?.text).toBe('result › 42 lines');
    const deltas = events.filter((e) => e.kind === 'text-delta');
    // The mid-part delta fell to the throttle; the seal carries the whole part.
    expect(deltas.map((e) => e.text)).toEqual(['Found ', 'Found it.']);
    expect(deltas[1]?.detail).toBe('end');
    expect(deltas[1]?.activity).toBe('Found it.');

    // The list poll completes the message: no duplicate text event (the
    // subscription sealed the same text), no duplicate tool note, and the
    // turn still ends through the idle marker.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(events.filter((e) => e.kind === 'text')).toEqual([]);
    expect(events.filter((e) => e.kind === 'note' && e.text === 'read src/a.ts')).toEqual([]);
    const result = events.find((e) => e.kind === 'result');
    expect(result?.text).toBe('Found it.');
    expect(proc.killTree).toHaveBeenCalled();

    proc.exit(null);
    vi.useRealTimers();
  });

  it('an event of another session is ignored; usage events report context and this run\'s own totals', async () => {
    vi.useFakeTimers();
    const channel = sseChannel();
    const { fetch } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      messages: () => [],
      eventStream: () => channel.response,
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);

    channel.push({ type: 'session.text.delta', data: { sessionID: 'ses_other', delta: 'not this run' } });
    channel.push(ev('session.step.started', {}));
    channel.push(ev('session.step.ended', { tokens: { input: 100, cache: { read: 20 }, output: 3 }, cost: 0.01 }));
    channel.push(ev('session.usage.updated', { cost: 0.02, tokens: { input: 10, cache: { read: 4 }, output: 5 } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(events.filter((e) => e.kind === 'text-delta')).toEqual([]);
    expect(events.find((e) => e.kind === 'usage' && e.turn !== undefined)?.turn).toBe('busy');
    expect(events.find((e) => e.kind === 'usage' && e.contextTokens !== undefined)?.contextTokens).toBe(120);
    const usage = events.find((e) => e.kind === 'usage' && e.tokensIn !== undefined);
    expect(usage?.tokensIn).toBe(14);
    expect(usage?.cacheReadTokens).toBe(4);
    expect(usage?.costUsd).toBe(0.02);

    proc.exit(null);
    vi.useRealTimers();
  });

  it('a dropped event stream falls back to the poll and reconnects', async () => {
    vi.useFakeTimers();
    const at = Date.now();
    const first = sseChannel();
    const second = sseChannel();
    let eventRounds = 0;
    const { fetch, calls } = scriptedFetch({
      sessionCreated: () => undefined,
      prompts: [],
      interrupts: [],
      // The poll still delivers the finished message — no SSE seal exists.
      messages: () => [
        { id: 'msg_i', type: 'idle', time: { created: at + 5_000 } },
        assistant(at),
      ],
      eventStream: () => {
        eventRounds += 1;
        return eventRounds === 1 ? first.response : second.response;
      },
    });
    const proc = fakeProcess();
    const { events, start } = collect();
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls.filter((c) => c.url.endsWith(OPENCODE_API.event))).toHaveLength(1);

    first.end(); // the server drops the stream
    await vi.advanceTimersByTimeAsync(2_500); // past EVENT_RETRY_MS
    expect(calls.filter((c) => c.url.endsWith(OPENCODE_API.event))).toHaveLength(2);

    // Polling covered the gap: the completed message's text arrived anyway.
    expect(events.find((e) => e.kind === 'text')?.text).toBe('Done.');

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

  it('a resumed session counts only this run: the totals before the first prompt are the base (req-53)', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    let created = false;
    const usage = { tokens: { input: 1_000, cache: { read: 9_000 }, output: 50 }, cost: 0.5 };
    const { fetch } = scriptedFetch({
      sessionCreated: () => {
        created = true;
      },
      prompts,
      interrupts: [],
      messages: () => [],
      usage,
    });
    const bases: unknown[] = [];
    const proc = fakeProcess();
    const { events, start } = collect({ resumeRef: 'ses_oc', onUsageBase: (base) => bases.push(base) });
    opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    // the stdout listener is attached once the port is picked
    await vi.advanceTimersByTimeAsync(100);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toBe(false);
    expect(bases).toEqual([{ tokensIn: 10_000, tokensOut: 50, cacheReadTokens: 9_000, costUsd: 0.5 }]);
    expect(prompts[0]).toContain('Do the ticket.');

    usage.tokens = { input: 1_500, cache: { read: 12_000 }, output: 80 };
    usage.cost = 0.7;
    await vi.advanceTimersByTimeAsync(2_500);
    const last = events.filter((e) => e.kind === 'usage' && e.tokensIn !== undefined).at(-1);
    expect(last?.tokensIn).toBe(3_500);
    expect(last?.cacheReadTokens).toBe(3_000);
    expect(last?.tokensOut).toBe(30);
    expect(last?.costUsd).toBeCloseTo(0.2);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a resume pre-flights the session — a missing one is reported, never prompted (T-0049)', async () => {
    vi.useFakeTimers();
    const prompts: string[] = [];
    const { fetch: base } = scriptedFetch({ sessionCreated: () => undefined, prompts, interrupts: [], messages: () => [] });
    const fetch: FetchFn = async (url, init) => {
      if (url.endsWith(OPENCODE_API.session('ses_oc'))) {
        return { ok: false, status: 404 } as unknown as Response;
      }
      return base(url, init);
    };
    const failures: string[] = [];
    const proc = fakeProcess();
    const { events, start } = collect({ resumeRef: 'ses_oc', onResumeFailed: (reason) => failures.push(reason) });
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('404');
    expect(prompts).toHaveLength(0);
    expect(events.some((e) => e.kind === 'error' && (e.text ?? '').includes('pre-flight'))).toBe(true);
    expect(proc.killTree).toHaveBeenCalled();
    await expect(handle.exited).resolves.toBe(-1);
    vi.useRealTimers();
  });

  it('compact-first settles the compact (its idle marker) before the instruction prompts (T-0049)', async () => {
    vi.useFakeTimers();
    const at = Date.now();
    const prompts: string[] = [];
    const promptWhenSettled: boolean[] = [];
    let compacts = 0;
    let rounds = 0;
    let settled = false;
    // While the compaction runs: only the `compaction` message, no idle
    // marker. From the third wait round on: the turn ended.
    const messages = (): unknown[] => {
      rounds += 1;
      if (rounds <= 2) {
        return [{ id: 'msg_c', type: 'compaction', time: { created: at + 1 } }];
      }
      settled = true;
      return [
        { id: 'msg_i2', type: 'idle', time: { created: at + 5_000 } },
        { id: 'msg_c', type: 'compaction', time: { created: at + 1 } },
      ];
    };
    const { fetch: base } = scriptedFetch({ sessionCreated: () => undefined, prompts: [], interrupts: [], messages });
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const fetch: FetchFn = async (url, init) => {
      if (url.endsWith(OPENCODE_API.compact('ses_oc'))) {
        compacts += 1;
        return json({ data: {} });
      }
      if (url.endsWith(OPENCODE_API.prompt('ses_oc'))) {
        promptWhenSettled.push(settled);
        prompts.push(String(init?.body));
        return json({ data: { id: 'msg_q', type: 'user', delivery: 'steer' } });
      }
      return base(url, init);
    };
    const proc = fakeProcess();
    const { events, start } = collect({ resumeRef: 'ses_oc', compactFirst: true });
    const handle = opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
    await vi.advanceTimersByTimeAsync(0);
    proc.stdout('server password sekrit');
    await vi.advanceTimersByTimeAsync(6_000);

    expect(compacts).toBe(1);
    // The instruction rode only once the compact had settled — and never
    // before (the idle-marker race the T-0049 pitfall pins).
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Do the ticket.');
    expect(promptWhenSettled).toEqual([true]);
    expect(events.some((e) => (e.text ?? '').includes('natively compacted'))).toBe(true);
    // The compact's own idle marker sits BEFORE lastPromptAt: the turn end
    // the poll saw belongs to the prompt, and the worker was killed then.
    expect(events.find((e) => e.kind === 'result')).toBeDefined();
    expect(proc.killTree).toHaveBeenCalled();
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a given base is subtracted as it is — an attached run keeps its own earlier spend counted', async () => {
    vi.useFakeTimers();
    const usage = { tokens: { input: 2_000, cache: { read: 18_000 }, output: 400 }, cost: 0 };
    const { fetch } = scriptedFetch({ sessionCreated: () => undefined, prompts: [], interrupts: [], messages: () => [], usage });
    const bases: unknown[] = [];
    const { events, start } = collect({
      resumeRef: 'ses_oc',
      usageBase: { tokensIn: 10_000, tokensOut: 50, cacheReadTokens: 9_000, costUsd: 0 },
      onUsageBase: (base) => bases.push(base),
    });
    const handle = opencodeAdapter(vi.fn() as unknown as SpawnFn, fetch, async () => 47000).attach!(start, {
      address: 'http://127.0.0.1:50001',
      password: 'pw',
      sessionRef: 'ses_oc',
      runStartedMs: Date.now(),
      seenBeforeMs: Date.now(),
      pid: 777,
      kill: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(bases).toEqual([]);
    const last = events.filter((e) => e.kind === 'usage' && e.tokensIn !== undefined).at(-1);
    expect(last?.tokensIn).toBe(10_000);
    expect(last?.cacheReadTokens).toBe(9_000);
    expect(last?.tokensOut).toBe(350);
    await handle.stop();
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

describe('question forms — what the owner answers', () => {
  const pick = { key: 'q0', header: 'Merge', question: 'How?', options: [{ label: 'Rebase' }, { label: 'Merge' }], multiple: false };
  const many = { key: 'q1', header: 'Checks', question: 'Which?', options: [{ label: 'lint' }, { label: 'tests' }], multiple: true };

  it('maps a typed answer to a choice by number or label, else keeps the words', () => {
    expect(answersFromText([pick], '2')).toEqual({ q0: 'Merge' });
    expect(answersFromText([pick], 'rebase')).toEqual({ q0: 'Rebase' });
    expect(answersFromText([pick], 'squash it, please')).toEqual({ q0: 'squash it, please' });
  });

  it('takes one line per question, commas for a multiple choice', () => {
    expect(answersFromText([pick, many], '1\n1, tests')).toEqual({ q0: 'Rebase', q1: ['lint', 'tests'] });
    expect(answersFromText([pick, many], '1')).toEqual({ q0: 'Rebase' });
  });

  it('says the questions and the answers in one line each', () => {
    expect(formText([pick])).toBe('How?');
    expect(formText([pick, many])).toBe('How? (+1 more)');
    expect(answersText([pick], { q0: 'Rebase' })).toBe('Rebase');
    expect(answersText([pick, many], { q1: ['lint'] })).toBe('Merge: —; Checks: lint');
  });
});

describe('questionOf / permissionText — what a worker waits on (req-64)', () => {
  it('reads the marker case-insensitively at the start of the message only', () => {
    expect(questionOf('QUESTION: Which API?')).toBe('Which API?');
    expect(questionOf('  question:\nA or B?\n')).toBe('A or B?');
    expect(questionOf('Done. QUESTION: none')).toBeNull();
    expect(questionOf('QUESTION:   ')).toBeNull();
  });

  it('accepts a marker on any line start — the last one wins (req-75)', () => {
    // A worker asking outside the W2 shape buries its marker mid-message
    // (evidence R-20261031T02050-wewb): the wait still sets. A marker in
    // running prose stays prose.
    expect(questionOf('All tests pass.\nQUESTION: Which API do you prefer?')).toBe('Which API do you prefer?');
    expect(questionOf('QUESTION: first\nsome detail\nQUESTION: second')).toBe('second');
    expect(questionOf('noise\nDone. QUESTION: none\nnoise')).toBeNull();
    // Text from the marker to the message's end, trimmed.
    expect(questionOf('QUESTION:\nA or B?\nplease advise')).toBe('A or B?\nplease advise');
  });

  it('names the action and its resources, plus a message that says more', () => {
    expect(permissionText({ action: 'bash', resources: ['rm -rf dist'] })).toBe('bash rm -rf dist');
    expect(permissionText({ action: 'edit', resources: ['a.ts'], message: 'outside the worktree' })).toBe(
      'edit a.ts — outside the worktree',
    );
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
    expect(toolActivity('question', { questions: [{ question: 'How should I merge?' }] })).toBe('asks How should I merge?');
    expect(toolActivity('shell', { command: 'x'.repeat(400) }).length).toBeLessThanOrEqual(140);
  });
});
