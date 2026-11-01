import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_API, opencodeAdapter, type FetchFn, type NormalizedEvent, type ProviderStart } from './providers';
import type { RunnerProcess, SpawnFn } from './procs';

/**
 * T-0052: the model's context window comes from the opencode server's
 * model surface (v2.0.32: `GET /api/model`, `GET /api/model/default`) —
 * resolved once per worker from the run's model pin, reported as a
 * `contextWindow` event. A miss is a note, the number is never guessed.
 */

/** A scripted process: the spec pushes the stdout credential line. */
function fakeProcess(): RunnerProcess & { stdout: (line: string) => void; killTree: ReturnType<typeof vi.fn>; exit: (code: number | null) => void } {
  const listeners = {
    stdout: (_line: string): void => undefined,
    exit: (_code: number | null): void => undefined,
  };
  const killTree = vi.fn(async () => undefined);
  const proc: RunnerProcess & {
    stdout: (line: string) => void;
    killTree: typeof killTree;
    exit: (code: number | null) => void;
  } = {
    pid: 4242,
    write: () => undefined,
    endInput: () => undefined,
    onStdout: (cb) => {
      listeners.stdout = cb;
    },
    onStderr: () => undefined,
    onExit: (cb) => {
      listeners.exit = cb;
    },
    stdout: (line) => listeners.stdout(`${line}\n`),
    killTree,
    exit: (code) => listeners.exit(code),
  };
  return proc;
}

const spawnOf = (proc: ReturnType<typeof fakeProcess>): SpawnFn => () => proc;

/**
 * A scripted server: everything the boot round needs answers empty; the
 * two model endpoints answer what the test pins.
 */
function serverFetch(opts: {
  /** `GET /api/model` — `{data: Model.Info[]}`. */
  catalog?: unknown;
  /** `GET /api/model/default` — `{data: Model.Info | undefined}`. */
  defaultModel?: unknown;
  /** Both model endpoints fail — non-ok status or a thrown error. */
  modelFails?: 'status' | 'throw';
}): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fetch: FetchFn = async (url, init) => {
    urls.push(url);
    if (url.endsWith(OPENCODE_API.info)) {
      return json({ version: '2.0.32' });
    }
    if (url.endsWith(OPENCODE_API.modelDefault)) {
      if (opts.modelFails === 'throw') {
        throw new Error('ECONNRESET');
      }
      return opts.modelFails === 'status' ? ({ ok: false, status: 500 } as Response) : json(opts.defaultModel ?? {});
    }
    if (url.endsWith(OPENCODE_API.models)) {
      if (opts.modelFails === 'throw') {
        throw new Error('ECONNRESET');
      }
      return opts.modelFails === 'status' ? ({ ok: false, status: 500 } as Response) : json(opts.catalog ?? {});
    }
    if (url.endsWith(OPENCODE_API.createSession) && init?.method === 'POST') {
      return json({ data: { id: 'ses_oc' } });
    }
    if (url.endsWith(OPENCODE_API.prompt('ses_oc'))) {
      return json({ data: {} });
    }
    if (url.endsWith(OPENCODE_API.messages('ses_oc'))) {
      return json({ data: [] });
    }
    if (url.endsWith(OPENCODE_API.session('ses_oc'))) {
      return json({ data: {} });
    }
    return json({});
  };
  return { fetch, urls };
}

const collect = (model: string | null): { events: NormalizedEvent[]; start: ProviderStart } => {
  const events: NormalizedEvent[] = [];
  const start: ProviderStart = {
    cwd: 'W:/kt',
    instruction: 'Do the ticket.',
    model,
    permissionMode: 'accept-edits',
    resumeRef: null,
    ticketId: 'T-0001',
    onEvent: (event) => events.push(event),
    onSessionRef: () => undefined,
  };
  return { events, start };
};

/** Boots a fresh worker through the fake server and waits out the start. */
async function booted(
  fetch: FetchFn,
  model: string | null,
): Promise<{ events: NormalizedEvent[]; proc: ReturnType<typeof fakeProcess> }> {
  const proc = fakeProcess();
  const { events, start } = collect(model);
  opencodeAdapter(spawnOf(proc), fetch, async () => 47000).spawn(start);
  await vi.advanceTimersByTimeAsync(0); // let the boot attach its stdout listener
  proc.stdout('server password sekrit');
  await vi.advanceTimersByTimeAsync(3_000);
  return { events, proc };
}

const model = (over: Record<string, unknown>): unknown => ({
  id: 'zai-coding-plan/glm-5.3',
  modelID: 'glm-5.3',
  providerID: 'zai-coding-plan',
  limit: { context: 1_000_000, output: 65_536 },
  ...over,
});

describe('the opencode adapter — the model context window (T-0052)', () => {
  it('reports the pinned model window from the catalog (providerID + id)', async () => {
    vi.useFakeTimers();
    const { fetch, urls } = serverFetch({ catalog: { data: [model({}), model({ id: 'other/x', modelID: 'x', providerID: 'other' })] } });
    const { events, proc } = await booted(fetch, 'zai-coding-plan/glm-5.3');
    expect(urls.some((u) => u.endsWith(OPENCODE_API.models))).toBe(true);
    expect(events.find((e) => e.contextWindow !== undefined)?.contextWindow).toBe(1_000_000);
    expect(events.filter((e) => e.contextWindow !== undefined)).toHaveLength(1);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('matches providerID + modelID when the catalog id differs, and strips a #variant pin', async () => {
    vi.useFakeTimers();
    // A config-added model keys differently from its upstream id.
    const { fetch } = serverFetch({ catalog: { data: [model({ id: 'my-own/glm', modelID: 'glm-5.3' })] } });
    const { events, proc } = await booted(fetch, 'zai-coding-plan/glm-5.3#fast');
    expect(events.find((e) => e.contextWindow !== undefined)?.contextWindow).toBe(1_000_000);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a pin the catalog does not name is one note, no window, never an error', async () => {
    vi.useFakeTimers();
    const { fetch, urls } = serverFetch({ catalog: { data: [model({ id: 'other/x', modelID: 'x', providerID: 'other' })] } });
    const { events, proc } = await booted(fetch, 'zai-coding-plan/nope');
    expect(events.filter((e) => e.contextWindow !== undefined)).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
    const notes = events.filter((e) => e.kind === 'note' && (e.text ?? '').startsWith('context window not reported'));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('zai-coding-plan/nope');
    expect(urls.some((u) => u.endsWith(OPENCODE_API.modelDefault))).toBe(false);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('without a pin the server default model answers', async () => {
    vi.useFakeTimers();
    const { fetch, urls } = serverFetch({ defaultModel: { data: model({ limit: { context: 200_000 } }) } });
    const { events, proc } = await booted(fetch, null);
    expect(urls.some((u) => u.endsWith(OPENCODE_API.modelDefault))).toBe(true);
    expect(urls.some((u) => u.endsWith(OPENCODE_API.models))).toBe(false);
    expect(events.find((e) => e.contextWindow !== undefined)?.contextWindow).toBe(200_000);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a server that names no default model is a note, no window', async () => {
    vi.useFakeTimers();
    const { fetch } = serverFetch({ defaultModel: { data: undefined } });
    const { events, proc } = await booted(fetch, null);
    expect(events.filter((e) => e.contextWindow !== undefined)).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'note' && (e.text ?? '').startsWith('context window not reported'))).toHaveLength(1);
    proc.exit(null);
    vi.useRealTimers();
  });

  it('a failed model fetch is a note, never an error', async () => {
    vi.useFakeTimers();
    const byStatus = serverFetch({ modelFails: 'status' });
    const statusRun = await booted(byStatus.fetch, 'zai-coding-plan/glm-5.3');
    expect(statusRun.events.filter((e) => e.contextWindow !== undefined)).toHaveLength(0);
    expect(statusRun.events.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(statusRun.events.filter((e) => e.kind === 'note' && (e.text ?? '').startsWith('context window not reported'))).toHaveLength(1);
    statusRun.proc.exit(null);

    const thrown = serverFetch({ modelFails: 'throw' });
    const throwRun = await booted(thrown.fetch, null);
    expect(throwRun.events.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(throwRun.events.filter((e) => e.kind === 'note' && (e.text ?? '').startsWith('context window not reported'))).toHaveLength(1);
    throwRun.proc.exit(null);
    vi.useRealTimers();
  });

  it('an attached worker reports its window too', async () => {
    vi.useFakeTimers();
    const { fetch, urls } = serverFetch({ catalog: { data: [model({})] } });
    const { events, start } = collect('zai-coding-plan/glm-5.3');
    opencodeAdapter(vi.fn() as unknown as SpawnFn, fetch, async () => 47000).attach!(start, {
      address: 'http://127.0.0.1:50001',
      password: 'pw',
      sessionRef: 'ses_oc',
      runStartedMs: Date.now(),
      seenBeforeMs: Date.now(),
      pid: 777,
      kill: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(urls.some((u) => u.startsWith('http://127.0.0.1:50001') && u.endsWith(OPENCODE_API.models))).toBe(true);
    expect(events.find((e) => e.contextWindow !== undefined)?.contextWindow).toBe(1_000_000);
    vi.useRealTimers();
  });
});
