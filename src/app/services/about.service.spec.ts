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
  /** Per-URL response factory; a URL with no entry 404s. */
  let responses: Record<string, () => Response>;

  const licenseManifest = (packages: unknown[]) =>
    new Response(JSON.stringify({ count: packages.length, packages }));

  beforeEach(() => {
    fetchCalls = 0;
    responses = {
      'assets/licenses.json': () => licenseManifest([]),
      'assets/build-info.json': () =>
        new Response(
          JSON.stringify({ buildNumber: 68, commit: 'd1d3088', builtAt: '2026-09-08T18:00:00.000Z' }),
        ),
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = String(input);
      const make = responses[url];
      return Promise.resolve(make ? make() : new Response('nope', { status: 404 }));
    }) as typeof globalThis.fetch;

    window.dreyApi = { getAppInfo: () => Promise.resolve(appInfo) } as DreyApi;
    service = TestBed.inject(AboutService);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('loads app info, build info and the license manifest', async () => {
    responses['assets/licenses.json'] = () =>
      licenseManifest([
        {
          name: 'yaml',
          version: '2.8.1',
          license: 'ISC',
          repository: null,
          publisher: null,
          licenseText: 'ISC License…',
        },
      ]);

    await service.load();

    expect(service.appInfo()).toEqual(appInfo);
    expect(service.buildInfo()?.buildNumber).toBe(68);
    expect(service.buildInfo()?.commit).toBe('d1d3088');
    expect(service.licenses().map((p) => p.name)).toEqual(['yaml']);
    expect(service.licensesError()).toBeNull();
  });

  it('records an error when the manifest is missing', async () => {
    delete responses['assets/licenses.json'];

    await service.load();

    expect(service.licenses()).toEqual([]);
    expect(service.licensesError()).toContain('404');
  });

  it('leaves build info null when the file is absent (dev without a stamp)', async () => {
    delete responses['assets/build-info.json'];

    await service.load();

    expect(service.buildInfo()).toBeNull();
    // A missing build-info file is not an error, unlike the license manifest.
    expect(service.licensesError()).toBeNull();
  });

  it('does not re-fetch once every source has loaded', async () => {
    await service.load();
    const afterFirst = fetchCalls;
    await service.load();

    expect(fetchCalls).toBe(afterFirst);
  });

  it('tolerates a missing Electron bridge', async () => {
    delete (window as { dreyApi?: unknown }).dreyApi;

    await service.load();

    expect(service.appInfo()).toBeNull();
    expect(service.licenses()).toEqual([]);
  });
});
