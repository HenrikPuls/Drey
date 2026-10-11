import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { KeybindingService } from '../keybindings';
import { EditorService } from '../services/editor.service';
import { HelpService } from './help.service';

describe('HelpService', () => {
  let service: HelpService;
  let editor: EditorService;
  let fetchedUrl: string | null;
  let fetchResponse: { ok: boolean; status: number; body: string };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.dreyApi = {} as DreyApi;
    fetchedUrl = null;
    fetchResponse = { ok: true, status: 200, body: '# The manual\n' };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrl = String(input);
      return {
        ok: fetchResponse.ok,
        status: fetchResponse.status,
        text: async () => fetchResponse.body,
      } as Response;
    }) as typeof fetch;
    service = TestBed.inject(HelpService);
    editor = TestBed.inject(EditorService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('fetches the bundled manual relative to the app origin and opens it pinned and read-only', async () => {
    await service.openManual();

    expect(fetchedUrl).toBe('manual/manual.md');
    const doc = editor.docFor(HelpService.MANUAL_PATH);
    expect(doc?.name).toBe('User manual');
    expect(doc?.pinned).toBe(true);
    expect(doc?.viewMode).toBe('view');
    expect(doc?.help).toEqual({ assetBase: 'manual/' });
    expect(doc?.bufferContent).toBe('# The manual\n');
  });

  it('surfaces a missing manual as the editor error instead of opening a tab', async () => {
    fetchResponse = { ok: false, status: 404, body: '' };

    await service.openManual();

    expect(editor.docFor(HelpService.MANUAL_PATH)).toBeNull();
    expect(editor.error()).toContain('manual could not be loaded');
  });

  it('opens the generated shortcuts document from the command registry', () => {
    const keys = TestBed.inject(KeybindingService);
    keys.register({ id: 'test.only', label: 'Test command', keybinding: 'Mod+T', run: () => undefined });

    service.openShortcuts();

    const doc = editor.docFor(HelpService.SHORTCUTS_PATH);
    expect(doc?.name).toBe('Keyboard shortcuts');
    expect(doc?.viewMode).toBe('view');
    expect(doc?.bufferContent).toContain('# Keyboard shortcuts');
    expect(doc?.bufferContent).toContain('| Test command | Ctrl T |');
  });
});
