import { createAssistantState, type AssistantPorts } from '../../../plugins/assistant/renderer/state';
import {
  createRunningTasks,
  type RunningTasks,
} from '../../../plugins/assistant/renderer/running-tasks';
import type { ChatThread } from '../../../plugins/assistant/shared/chat-thread';
import { emptyThread } from '../../../plugins/assistant/shared/chat-thread';

/**
 * Specs for the assistant plugin's renderer state (`plugins/assistant/`):
 * the auto-summary rule, the per-note switch, restart-from-here and the
 * thread persistence -- ported from the pre-conversion
 * `AssistantService` spec (ADR-0044 stage 7). The Angular runner ignores
 * `plugins/**`, so plugin specs live here and import the plugin sources.
 *
 * The state factory takes its ports injected, so no `window.dreyApi` or
 * plugin host is involved.
 */

interface Harness {
  state: ReturnType<typeof createAssistantState>;
  tasks: RunningTasks;
  threads: Map<string, ChatThread>;
  written: ChatThread[];
  summaries: Array<string | undefined>;
  cancelled: string[];
  /** The "active document" the ports report; null = nothing text-shaped open. */
  setActive(path: string | null, body?: string): void;
  llm: { on: boolean };
  defaultAutoSummary: boolean;
}

function setup(options: { autoSummary?: boolean; llm?: boolean } = {}): Harness {
  const threads = new Map<string, ChatThread>();
  const written: ChatThread[] = [];
  const summaries: Array<string | undefined> = [];
  const cancelled: string[] = [];
  const h: Harness = {
    threads,
    written,
    summaries,
    cancelled,
    llm: { on: options.llm !== false },
    defaultAutoSummary: options.autoSummary !== false,
    setActive: (path, body) => {
      activePath = path;
      activeBody = body ?? '# Note\n\nInhalt\n';
    },
    state: undefined as never,
    tasks: undefined as never,
  };
  let activePath: string | null = null;
  let activeBody = '';

  const tasks = createRunningTasks(async (taskId) => {
    cancelled.push(taskId);
    return true;
  });

  const ports: AssistantPorts = {
    readThread: async (notePath) => threads.get(notePath) ?? emptyThread(notePath),
    writeThread: async (thread) => {
      written.push(thread);
      threads.set(thread.notePath, thread);
    },
    summarize: async (context, taskId) => {
      summaries.push(taskId);
      return 'Kurze Zusammenfassung.';
    },
    ask: async () => ({ kind: 'answer', text: 'Antwort.' }),
    cancel: async (taskId) => {
      if (taskId !== undefined) {
        cancelled.push(taskId);
      }
    },
    activeDoc: () => (activePath === null ? null : { path: activePath, body: activeBody }),
    llmEnabled: () => h.llm.on,
    autoSummaryDefault: () => h.defaultAutoSummary,
    requestRewrite: async () => true,
  };

  h.tasks = tasks;
  h.state = createAssistantState(ports, tasks);
  return h;
}

describe('assistant plugin state (plugins/assistant/renderer/state)', () => {
  it('summarises a note opened for the first time when the default is on', async () => {
    const h = setup();
    h.setActive('daily/2026-09-26.md');
    await h.state.openNote('daily/2026-09-26.md');

    expect(h.summaries).toHaveLength(1);
    expect(h.state.cards().map((card) => card.role)).toEqual(['summary']);
    expect(h.state.cards()[0].text).toBe('Kurze Zusammenfassung.');
    // The card is persisted to the sidecar, not into the note.
    expect(h.written).toHaveLength(1);
    expect(h.written[0].notePath).toBe('daily/2026-09-26.md');
  });

  it('does nothing automatically when the default is off', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.cards()).toEqual([]);
    expect(h.state.autoSummary()).toBe(false);
  });

  it('offers a manual summary when the default is off, and runs it on demand', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.state.canSummarize()).toBe(true);
    await h.state.summarizeNow();

    expect(h.summaries).toHaveLength(1);
    expect(h.state.cards().map((card) => card.role)).toEqual(['summary']);
    expect(h.state.canSummarize()).toBe(false);
  });

  it('summarises when the panel switch is turned on after opening', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    h.state.setAutoSummary(true);
    // The turn-on summary runs async through the task tracker; flush it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.summaries).toHaveLength(1);
  });

  it('does not re-summarise a note that already has a sidecar thread', async () => {
    const h = setup();
    h.threads.set('a.md', {
      version: 1,
      notePath: 'a.md',
      cards: [{ id: 'a', role: 'summary', text: 'Schon da.', at: '' }],
    });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.cards()[0].text).toBe('Schon da.');
  });

  it('never summarises while LLM features are off', async () => {
    const h = setup({ llm: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.canSummarize()).toBe(false);
  });

  it('passes a cancellable task id into the generation', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(1);
    expect(typeof h.summaries[0]).toBe('string');
  });

  it('keeps a per-note switch without changing the global default', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.state.setAutoSummary(false);

    h.setActive('b.md');
    await h.state.openNote('b.md');

    // b.md still follows the (unchanged) default.
    expect(h.state.autoSummary()).toBe(true);
    expect(h.defaultAutoSummary).toBe(true);
  });

  it('rewinds the thread to before a card and rewrites the sidecar', async () => {
    const h = setup({ autoSummary: false });
    h.threads.set('a.md', {
      version: 1,
      notePath: 'a.md',
      cards: [
        { id: 's', role: 'summary', text: 'Zusammenfassung.', at: '' },
        { id: 'q1', role: 'question', text: 'Erste Frage?', at: '' },
        { id: 'a1', role: 'answer', text: 'Erste Antwort.', at: '', durationMs: 1000 },
        { id: 'q2', role: 'question', text: 'Zweite Frage?', at: '' },
        { id: 'a2', role: 'answer', text: 'Zweite Antwort.', at: '', durationMs: 2000 },
      ],
    });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.state.laterCount('q2')).toBe(2);

    const restored = await h.state.restartFrom('q2');

    expect(restored).toBe('Zweite Frage?');
    expect(h.state.cards().map((card) => card.id)).toEqual(['s', 'q1', 'a1']);
    expect(h.written.at(-1)?.cards.map((card) => card.id)).toEqual(['s', 'q1', 'a1']);
  });

  it('returns null when the rewind point is not a question', async () => {
    const h = setup({ autoSummary: false });
    h.threads.set('a.md', {
      version: 1,
      notePath: 'a.md',
      cards: [
        { id: 'q1', role: 'question', text: 'Frage?', at: '' },
        { id: 'a1', role: 'answer', text: 'Antwort.', at: '', durationMs: 1000 },
      ],
    });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    const restored = await h.state.restartFrom('a1');

    expect(restored).toBeNull();
    expect(h.state.cards().map((card) => card.id)).toEqual(['q1']);
  });

  it('an ask turn records the question and the answer card and persists both', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md', 'Inhalt');
    await h.state.openNote('a.md');

    const sent = await h.state.ask('Was steht hier?');

    expect(sent).toBe(true);
    expect(h.state.cards().map((card) => card.role)).toEqual(['question', 'answer']);
    expect(h.state.cards()[0].text).toBe('Was steht hier?');
    expect(h.state.cards()[1].text).toBe('Antwort.');
    expect(h.written).toHaveLength(2);
  });

  it('rejects a question when no note is open', async () => {
    const h = setup({ autoSummary: false });
    h.setActive(null);

    expect(await h.state.ask('Frage?')).toBe(false);
  });

  it('records a manual Action noop/error as the action message', () => {
    const h = setup();
    h.state.reportActionOutcome({
      kind: 'noop',
      triggerId: 't1',
      name: 'Reformat',
      message: 'The model returned the document unchanged.',
    });
    expect(h.state.actionMessage()).toBe(
      'Reformat: The model returned the document unchanged.',
    );
    h.state.dismissActionMessage();
    expect(h.state.actionMessage()).toBeNull();
  });

  it('the running-task tracker reports a label while a generation runs', async () => {
    const h = setup();
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    const running = h.tasks.run('Summarising', () => gate);

    expect(h.tasks.isRunning()).toBe(true);
    expect(h.tasks.currentLabel()).toMatch(/^Summarising · thinking \d+s$/);

    release('Kurze Zusammenfassung.');
    await running;
    expect(h.tasks.isRunning()).toBe(false);
    expect(h.tasks.currentLabel()).toBeNull();
  });
});
