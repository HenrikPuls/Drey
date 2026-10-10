import { TestBed } from '@angular/core/testing';
import { AppConfig, DEFAULT_APP_CONFIG } from '../../../shared/app-config';
import { DreyApi, ToolApprovalRequest } from '../../../shared/ipc-api';
import { SettingsService } from '../services/settings.service';
import { ToolApprovalService } from './tool-approval.service';

/** The external tool approval queue (milestone 63, ADR-0063). */
describe('ToolApprovalService', () => {
  let service: ToolApprovalService;
  let settings: SettingsService;
  let decisions: Array<{ id: number; approved: boolean }>;
  let stored: AppConfig;

  const request = (id: number, source: string): ToolApprovalRequest => ({
    id,
    source,
    sourceName: source,
    tool: 't',
    args: {},
  });

  beforeEach(async () => {
    decisions = [];
    stored = structuredClone(DEFAULT_APP_CONFIG);
    stored.tools.servers = [
      {
        id: 'brave',
        name: 'Brave',
        enabled: true,
        approval: 'ask',
        transport: { kind: 'http', url: 'https://x/mcp', headers: {} },
      },
    ];
    const api: Partial<DreyApi> = {
      getConfig: () => Promise.resolve(structuredClone(stored)),
      setConfig: (next: AppConfig) => {
        stored = structuredClone(next);
        return Promise.resolve(structuredClone(stored));
      },
      resolveToolApproval: (id: number, approved: boolean) => {
        decisions.push({ id, approved });
        return Promise.resolve();
      },
    };
    window.dreyApi = api as DreyApi;
    settings = TestBed.inject(SettingsService);
    await settings.load();
    service = TestBed.inject(ToolApprovalService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('asks one call at a time, in order', async () => {
    service.enqueue(request(1, 'brave'));
    service.enqueue(request(2, 'web'));
    expect(service.pending()?.id).toBe(1);
    expect(service.waiting()).toBe(1);

    await service.answer('allow');
    expect(service.pending()?.id).toBe(2);
    await service.answer('deny');
    expect(service.pending()).toBeNull();
    expect(decisions).toEqual([
      { id: 1, approved: true },
      { id: 2, approved: false },
    ]);
  });

  it('"Always allow" persists the source rule and answers its waiting calls too', async () => {
    service.enqueue(request(1, 'brave'));
    service.enqueue(request(2, 'web'));
    service.enqueue(request(3, 'brave'));

    await service.answer('always');
    expect(stored.tools.servers[0].approval).toBe('allow');
    expect(stored.tools.webFetch.approval).toBe('ask');
    expect(decisions).toEqual([
      { id: 1, approved: true },
      { id: 3, approved: true },
    ]);
    expect(service.pending()?.id).toBe(2);

    await service.answer('always');
    expect(stored.tools.webFetch.approval).toBe('allow');
  });
});
