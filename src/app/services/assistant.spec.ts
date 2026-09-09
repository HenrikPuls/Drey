import { TestBed } from '@angular/core/testing';
import { AppConfig, ChatThread, DreyApi } from '../../../shared/ipc-api';
import { DEFAULT_APP_CONFIG } from '../../../shared/app-config';
import { AssistantService } from './assistant.service';
import { EditorService } from './editor.service';
import { SettingsService } from './settings.service';

/** Lets the service's `effect` and its awaited IPC calls settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    TestBed.tick();
    await Promise.resolve();
  }
};

describe('AssistantService', () => {
  let assistant: AssistantService;
  let editor: EditorService;
  let written: ChatThread[];
  let summaries: number;
  let stored: Record<string, ChatThread>;
  let summarizeTaskIds: Array<string | undefined>;
  let cancelled: string[];

  function setup(options: { autoSummary?: boolean; llm?: boolean } = {}): void {
    written = [];
    summaries = 0;
    stored = {};
    summarizeTaskIds = [];
    cancelled = [];
    const config: AppConfig = {
      ...structuredClone(DEFAULT_APP_CONFIG),
      llm: { ...DEFAULT_APP_CONFIG.llm, enabled: options.llm !== false },
      assistant: { autoSummaryDefault: options.autoSummary !== false },
    };

    window.dreyApi = {
      getConfig: () => Promise.resolve(config),
      readVaultFile: () => Promise.resolve({ content: '# Note\n\nInhalt\n', modifiedMs: 1 }),
      listTags: () => Promise.resolve([]),
      readChatThread: (notePath: string) =>
        Promise.resolve(stored[notePath] ?? { version: 1, notePath, cards: [] }),
      writeChatThread: (thread: ChatThread) => {
        written.push(thread);
        stored[thread.notePath] = thread;
        return Promise.resolve();
      },
      summarizeNote: (_context: unknown, taskId?: string) => {
        summaries++;
        summarizeTaskIds.push(taskId);
        return Promise.resolve('Kurze Zusammenfassung.');
      },
      cancelLlmTask: (taskId: string) => {
        cancelled.push(taskId);
        return Promise.resolve(true);
      },
    } as unknown as DreyApi;

    editor = TestBed.inject(EditorService);
    TestBed.inject(SettingsService);
    assistant = TestBed.inject(AssistantService);
  }

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('reflects the LLM master switch through llmEnabled (off)', async () => {
    setup({ llm: false });
    await settle();
    expect(assistant.llmEnabled()).toBe(false);
  });

  it('reflects the LLM master switch through llmEnabled (on)', async () => {
    setup();
    await settle();
    expect(assistant.llmEnabled()).toBe(true);
  });

  it('survives a preload that predates the assistant channels', async () => {
    setup();
    // An older preload: the object exists, the methods do not.
    window.dreyApi = {
      getConfig: window.dreyApi.getConfig,
      readVaultFile: window.dreyApi.readVaultFile,
      listTags: window.dreyApi.listTags,
    } as unknown as DreyApi;

    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(assistant.cards()).toEqual([]);
  });

  it('summarises a note opened for the first time when the toggle is on', async () => {
    setup();
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(summaries).toBe(1);
    expect(assistant.cards().map((card) => card.role)).toEqual(['summary']);
    expect(assistant.cards()[0].text).toBe('Kurze Zusammenfassung.');
    // The card is persisted to the sidecar, not into the note.
    expect(written).toHaveLength(1);
    expect(written[0].notePath).toBe('daily/2026-09-26.md');
  });

  it('records how long the generation took, on the card and in the sidecar', async () => {
    setup();
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    const card = assistant.cards()[0];
    expect(typeof card.durationMs).toBe('number');
    expect(assistant.took(card.durationMs)).toMatch(/^took \d+s$/);
    expect(typeof written[0].cards[0].durationMs).toBe('number');
  });

  it('passes a cancellable task id into the generation', async () => {
    setup();
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(summarizeTaskIds).toHaveLength(1);
    expect(typeof summarizeTaskIds[0]).toBe('string');
  });

  it('a question card carries no duration -- nothing was generated for it', async () => {
    setup();
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();
    expect(assistant.took(undefined)).toBeNull();
  });

  it('does nothing automatically when the toggle default is off', async () => {
    setup({ autoSummary: false });
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(summaries).toBe(0);
    expect(assistant.cards()).toEqual([]);
    expect(assistant.autoSummary()).toBe(false);
  });

  it('offers a manual summary when the toggle is off, and runs it on demand', async () => {
    setup({ autoSummary: false });
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(assistant.canSummarize()).toBe(true);
    await assistant.summarizeNow();
    await settle();

    expect(summaries).toBe(1);
    expect(assistant.cards().map((card) => card.role)).toEqual(['summary']);
    expect(assistant.canSummarize()).toBe(false);
  });

  it('summarises when the panel toggle is switched on after opening', async () => {
    setup({ autoSummary: false });
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    assistant.setAutoSummary(true);
    await settle();

    expect(summaries).toBe(1);
  });

  it('does not re-summarise a note that already has a sidecar thread', async () => {
    setup();
    stored['daily/2026-09-26.md'] = {
      version: 1,
      notePath: 'daily/2026-09-26.md',
      cards: [{ id: 'a', role: 'summary', text: 'Schon da.', at: '' }],
    };
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(summaries).toBe(0);
    expect(assistant.cards()[0].text).toBe('Schon da.');
  });

  it('never summarises while LLM features are off', async () => {
    setup({ llm: false });
    await settle();
    await editor.openFile('daily/2026-09-26.md');
    await settle();

    expect(summaries).toBe(0);
    expect(assistant.canSummarize()).toBe(false);
  });

  it('rewinds the thread to before a card and rewrites the sidecar', async () => {
    setup({ autoSummary: false });
    stored['a.md'] = {
      version: 1,
      notePath: 'a.md',
      cards: [
        { id: 's', role: 'summary', text: 'Zusammenfassung.', at: '' },
        { id: 'q1', role: 'question', text: 'Erste Frage?', at: '' },
        { id: 'a1', role: 'answer', text: 'Erste Antwort.', at: '', durationMs: 1000 },
        { id: 'q2', role: 'question', text: 'Zweite Frage?', at: '' },
        { id: 'a2', role: 'answer', text: 'Zweite Antwort.', at: '', durationMs: 2000 },
      ],
    };
    await settle();
    await editor.openFile('a.md');
    await settle();

    expect(assistant.laterCount('q2')).toBe(2);

    const restored = await assistant.restartFrom('q2');
    await settle();

    expect(restored).toBe('Zweite Frage?');
    expect(assistant.cards().map((card) => card.id)).toEqual(['s', 'q1', 'a1']);
    expect(written.at(-1)?.cards.map((card) => card.id)).toEqual(['s', 'q1', 'a1']);
  });

  it('returns null when the rewind point is not a question', async () => {
    setup({ autoSummary: false });
    stored['a.md'] = {
      version: 1,
      notePath: 'a.md',
      cards: [
        { id: 'q1', role: 'question', text: 'Frage?', at: '' },
        { id: 'a1', role: 'answer', text: 'Antwort.', at: '', durationMs: 1000 },
      ],
    };
    await settle();
    await editor.openFile('a.md');
    await settle();

    const restored = await assistant.restartFrom('a1');
    await settle();

    expect(restored).toBeNull();
    expect(assistant.cards().map((card) => card.id)).toEqual(['q1']);
  });

  it('keeps a per-note toggle without changing the global default', async () => {
    setup();
    await settle();
    await editor.openFile('a.md');
    await settle();
    assistant.setAutoSummary(false);

    await editor.openFile('b.md');
    await settle();

    // b.md still follows the (unchanged) default.
    expect(assistant.autoSummary()).toBe(true);
    expect(TestBed.inject(SettingsService).config()?.assistant.autoSummaryDefault).toBe(true);
  });
});
