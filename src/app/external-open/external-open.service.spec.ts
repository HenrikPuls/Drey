import { TestBed } from '@angular/core/testing';
import { DreyApi, OpenRequest } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { ExternalOpenService } from './external-open.service';

describe('ExternalOpenService', () => {
  let service: ExternalOpenService;
  let editor: EditorService;
  let pushListeners: Array<(requests: OpenRequest[]) => void>;
  let pulled: number;
  let pending: OpenRequest[];

  beforeEach(() => {
    pushListeners = [];
    pulled = 0;
    pending = [];
    const fakeApi: Partial<DreyApi> = {
      readVaultFile: (relativePath: string) =>
        Promise.resolve({ content: `vault: ${relativePath}`, modifiedMs: 1 }),
      readExternalFile: (absolutePath: string) =>
        Promise.resolve({ content: `external: ${absolutePath}`, modifiedMs: 2 }),
      takePendingOpenRequests: () => {
        pulled += 1;
        return Promise.resolve(pending);
      },
      onOpenRequest: (listener: (requests: OpenRequest[]) => void) => {
        pushListeners.push(listener);
        return () => undefined;
      },
    };
    window.dreyApi = fakeApi as DreyApi;
    service = TestBed.inject(ExternalOpenService);
    editor = TestBed.inject(EditorService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('pulls the launch files once startup has settled and opens them', async () => {
    pending = [
      { kind: 'vault', vaultId: 'v1', path: 'notes/a.md' },
      { kind: 'external', path: '/tmp/b.md' },
    ];
    service.start();
    expect(await service.onStartupSettled()).toBe(2);

    expect(editor.docFor('v1::notes/a.md')).not.toBeNull();
    expect(editor.docFor('external:///tmp/b.md')?.external).toBe(true);
    // the LAST request keeps the focus
    expect(editor.activePath()).toBe('external:///tmp/b.md');
  });

  it('pulls only once, however often startup settles', async () => {
    await service.onStartupSettled();
    await service.onStartupSettled();
    expect(pulled).toBe(1);
  });

  it('opens a later launch that arrives as a push', async () => {
    service.start();
    expect(pushListeners).toHaveLength(1);

    pushListeners[0]([{ kind: 'external', path: '/tmp/late.md' }]);
    await new Promise((resolve) => setTimeout(resolve));

    expect(editor.docFor('external:///tmp/late.md')?.external).toBe(true);
  });

  it('subscribes only once', () => {
    service.start();
    service.start();
    expect(pushListeners).toHaveLength(1);
  });

  it('does nothing without the Electron bridge', async () => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    expect(() => service.start()).not.toThrow();
    await expect(service.onStartupSettled()).resolves.toBe(0);
  });
});
