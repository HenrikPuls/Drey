import { TestBed } from '@angular/core/testing';
import { DreyApi, OpenDocsReply, OpenDocsRequest } from '../../../shared/ipc-api';
import { EditorService } from './editor.service';
import { OpenDoc, textDoc } from './open-doc';
import { OpenDocsBridgeService } from './open-docs-bridge.service';

/** What the vault tools ask about open tabs (milestone 78, ADR-0071). */
describe('OpenDocsBridgeService', () => {
  let service: OpenDocsBridgeService;
  let docs: OpenDoc[];
  let calls: string[];
  let replies: Array<{ id: number; reply: OpenDocsReply }>;
  let push: (request: OpenDocsRequest) => void;
  /** What a save does to the tab: `true` leaves it clean. */
  let saveSucceeds: boolean;

  const open = (path: string, saved: string, buffer = saved, vaultId: string | null = 'v1'): OpenDoc => {
    const doc = { ...textDoc(path, vaultId, saved, 1, true, 'live'), bufferContent: buffer };
    docs.push(doc);
    return doc;
  };

  beforeEach(() => {
    docs = [];
    calls = [];
    replies = [];
    saveSucceeds = true;
    const editor: Partial<EditorService> = {
      openDocs: (() => docs) as EditorService['openDocs'],
      docFor: (key) => docs.find((doc) => doc.key === key) ?? null,
      updateBuffer: (key, content) => {
        calls.push(`updateBuffer ${key}`);
        const doc = docs.find((entry) => entry.key === key);
        if (doc) {
          doc.bufferContent = content;
        }
      },
      applyRewrite: async (key, content, origin) => {
        calls.push(`applyRewrite ${key} ${origin}`);
        const doc = docs.find((entry) => entry.key === key);
        if (doc) {
          doc.bufferContent = content;
          if (saveSucceeds) {
            doc.savedContent = content;
          }
        }
      },
      retargetTabs: (from, to) => {
        calls.push(`retarget ${from} > ${to}`);
      },
      closeTabsUnder: (vaultId, path) => {
        calls.push(`close ${vaultId} ${path}`);
      },
    };
    const api: Partial<DreyApi> = {
      onOpenDocsRequest: (listener) => {
        push = listener;
        return () => undefined;
      },
      replyOpenDocs: (id, reply) => {
        replies.push({ id, reply });
        return Promise.resolve();
      },
    };
    window.dreyApi = api as DreyApi;
    TestBed.configureTestingModule({ providers: [{ provide: EditorService, useValue: editor }] });
    service = TestBed.inject(OpenDocsBridgeService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('answers a request over the reply channel', async () => {
    open('a.md', 'Saved\n', 'Typed\n');
    service.start();

    push({ id: 7, kind: 'peek', vaultId: 'v1', path: 'a.md' });
    await Promise.resolve();
    await Promise.resolve();

    expect(replies).toEqual([
      { id: 7, reply: { buffers: [{ vaultId: 'v1', path: 'a.md', content: 'Typed\n', dirty: true }] } },
    ]);
  });

  it('peeks the buffer of an open vault file, and nothing for a file that is not open', async () => {
    open('a.md', 'Saved\n');

    expect(await service.handle({ id: 1, kind: 'peek', vaultId: 'v1', path: 'a.md' })).toEqual({
      buffers: [{ vaultId: 'v1', path: 'a.md', content: 'Saved\n', dirty: false }],
    });
    expect(await service.handle({ id: 2, kind: 'peek', vaultId: 'v1', path: 'b.md' })).toEqual({
      buffers: [],
    });
    // The same path in another vault is another file.
    expect(await service.handle({ id: 3, kind: 'peek', vaultId: 'v2', path: 'a.md' })).toEqual({
      buffers: [],
    });
  });

  it('counts a daily-note draft as open: its tab is where the text is', async () => {
    const draft = open('daily/2026-10-13.md', '# Today');
    draft.existsOnDisk = false;

    const reply = await service.handle({ id: 1, kind: 'peek', vaultId: 'v1', path: draft.path });

    expect(reply.buffers).toHaveLength(1);
  });

  it('lists the unsaved vault files only', async () => {
    open('clean.md', 'x\n');
    open('dirty.md', 'x\n', 'y\n');
    open('Untitled-1', '', 'scratch\n', null);

    expect(await service.handle({ id: 1, kind: 'dirty' })).toEqual({
      buffers: [{ vaultId: 'v1', path: 'dirty.md', content: 'y\n', dirty: true }],
    });
  });

  it('applies a change to the buffer without saving', async () => {
    open('a.md', 'Old\n');

    const reply = await service.handle({
      id: 1,
      kind: 'apply',
      vaultId: 'v1',
      path: 'a.md',
      content: 'New\n',
      save: false,
      origin: 'assistant',
    });

    expect(reply).toEqual({ applied: true, saved: false });
    expect(calls).toEqual(['updateBuffer v1::a.md']);
  });

  it('applies and saves, and says when the save left the tab unsaved', async () => {
    open('a.md', 'Old\n');
    const request: OpenDocsRequest = {
      id: 1,
      kind: 'apply',
      vaultId: 'v1',
      path: 'a.md',
      content: 'New\n',
      save: true,
      origin: 'mcp',
    };

    expect(await service.handle(request)).toEqual({ applied: true, saved: true });
    expect(calls).toEqual(['applyRewrite v1::a.md mcp']);

    saveSucceeds = false;
    expect(await service.handle({ ...request, content: 'Newer\n' })).toEqual({
      applied: true,
      saved: false,
    });
  });

  it('reaches a tab that was never saved by its name and an empty vault id, and never saves it', async () => {
    const tab = open('untitled.md', '', 'Draft\n', null);
    tab.askOnSave = true;

    expect(await service.handle({ id: 1, kind: 'peek', vaultId: '', path: 'untitled.md' })).toEqual({
      buffers: [{ vaultId: '', path: 'untitled.md', content: 'Draft\n', dirty: true }],
    });
    // A vault file of the same name is another document.
    expect((await service.handle({ id: 2, kind: 'peek', vaultId: 'v1', path: 'untitled.md' })).buffers).toEqual([]);

    const reply = await service.handle({
      id: 3,
      kind: 'apply',
      vaultId: '',
      path: 'untitled.md',
      content: 'Final\n',
      save: false,
      origin: 'assistant',
    });
    expect(reply).toEqual({ applied: true, saved: false });
    expect(calls).toEqual(['updateBuffer untitled.md']);
  });

  it('applies nothing to a file that is not open', async () => {
    expect(
      await service.handle({
        id: 1,
        kind: 'apply',
        vaultId: 'v1',
        path: 'gone.md',
        content: 'x',
        save: true,
        origin: 'assistant',
      }),
    ).toEqual({ applied: false, saved: false });
    expect(calls).toEqual([]);
  });

  it('retargets the tab of a moved file and closes the tab of a deleted one', async () => {
    await service.handle({ id: 1, kind: 'moved', vaultId: 'v1', from: 'a.md', to: 'b/a.md' });
    await service.handle({ id: 2, kind: 'closed', vaultId: 'v1', path: 'old.md' });

    expect(calls).toEqual(['retarget v1::a.md > v1::b/a.md', 'close v1 old.md']);
  });
});
