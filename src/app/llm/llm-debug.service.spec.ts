import { TestBed } from '@angular/core/testing';
import { DreyApi, LlmDebugEntry } from '../../../shared/ipc-api';
import { LlmDebugService } from './llm-debug.service';

function entry(id: number): LlmDebugEntry {
  return {
    id,
    at: '14:00:00.000',
    provider: 'lmstudio',
    method: 'GET',
    url: 'http://127.0.0.1:8888/v1/models',
    headers: { authorization: 'Bearer sk-unslo…3456' },
    authSent: true,
    body: null,
    status: 200,
    durationMs: 5,
    responseBody: '{"data":[]}',
    error: null,
  };
}

describe('LlmDebugService', () => {
  let service: LlmDebugService;
  let push: ((entry: LlmDebugEntry) => void) | null;

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  function install(api: Partial<DreyApi>): void {
    push = null;
    window.dreyApi = {
      onLlmDebugEntry: (listener: (e: LlmDebugEntry) => void) => {
        push = listener;
        return () => {
          push = null;
        };
      },
      clearLlmDebugLog: () => Promise.resolve(),
      ...api,
    } as DreyApi;
    service = TestBed.inject(LlmDebugService);
  }

  it('loads the backlog recorded before the panel was opened', async () => {
    install({ getLlmDebugLog: () => Promise.resolve([entry(1), entry(2)]) });

    await service.start();

    expect(service.entries().map((e) => e.id)).toEqual([1, 2]);
    expect(service.error()).toBeNull();
  });

  it('appends live entries as requests happen', async () => {
    install({ getLlmDebugLog: () => Promise.resolve([entry(1)]) });
    await service.start();

    push!(entry(2));

    expect(service.entries().map((e) => e.id)).toEqual([1, 2]);
  });

  it('does not lose an entry that arrives while the backlog is still loading', async () => {
    let resolveBacklog: (value: LlmDebugEntry[]) => void = () => {};
    install({
      getLlmDebugLog: () =>
        new Promise<LlmDebugEntry[]>((resolve) => {
          resolveBacklog = resolve;
        }),
    });

    const started = service.start();
    push!(entry(9)); // lands mid-await -- used to be overwritten by the backlog
    resolveBacklog([entry(1)]);
    await started;

    expect(service.entries().map((e) => e.id)).toEqual([1, 9]);
  });

  it('does not duplicate an entry present in both the push and the backlog', async () => {
    install({ getLlmDebugLog: () => Promise.resolve([entry(1), entry(2)]) });
    await service.start();

    push!(entry(2));

    expect(service.entries().map((e) => e.id)).toEqual([1, 2]);
  });

  it('surfaces a failure to read the log instead of showing an empty panel', async () => {
    install({
      getLlmDebugLog: () => Promise.reject(new Error("No handler registered for 'llm:debug-list'")),
    });

    await service.start();

    expect(service.error()).toContain('llm:debug-list');
    expect(service.entries()).toEqual([]);
  });

  it('reports the missing bridge outside Electron', async () => {
    service = TestBed.inject(LlmDebugService);
    await service.start();
    expect(service.error()).toContain('Not running inside Electron');
  });
});
