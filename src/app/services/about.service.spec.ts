import { TestBed } from '@angular/core/testing';
import { AboutService } from './about.service';
import { AppInfo, DreyApi } from '../../../shared/ipc-api';

const appInfo: AppInfo = {
  appVersion: '1.2.3',
  electronVersion: '44.0.0',
  nodeVersion: '24.20.0',
  chromeVersion: '130.0.0',
  platform: 'win32',
};

describe('AboutService', () => {
  let service: AboutService;
  let realFetch: typeof globalThis.fetch;
  let fetchCalls: number;
  let nextResponse: () => Response;

  beforeEach(() => {
    fetchCalls = 0;
    nextResponse = () => new Response(JSON.stringify({ count: 0, packages: [] }));
    realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(nextResponse());
    }) as typeof globalThis.fetch;

    window.dreyApi = { getAppInfo: () => Promise.resolve(appInfo) } as DreyApi;
    service = TestBed.inject(AboutService);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('loads app info and the license manifest', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          count: 1,
          packages: [
            {
              name: 'yaml',
              version: '2.8.1',
              license: 'ISC',
              repository: null,
              publisher: null,
              licenseText: 'ISC License…',
            },
          ],
        }),
      );

    await service.load();

    expect(service.appInfo()).toEqual(appInfo);
    expect(service.licenses().map((p) => p.name)).toEqual(['yaml']);
    expect(service.licensesError()).toBeNull();
  });

  it('records an error when the manifest is missing', async () => {
    nextResponse = () => new Response('nope', { status: 404 });

    await service.load();

    expect(service.licenses()).toEqual([]);
    expect(service.licensesError()).toContain('404');
  });

  it('does not re-fetch once both sources have loaded', async () => {
    await service.load();
    await service.load();

    expect(fetchCalls).toBe(1);
  });

  it('tolerates a missing Electron bridge', async () => {
    delete (window as { dreyApi?: unknown }).dreyApi;

    await service.load();

    expect(service.appInfo()).toBeNull();
    expect(service.licenses()).toEqual([]);
  });
});
