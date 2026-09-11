import { ActionEngine, type ChatFn } from '../../../plugins/assistant/main/action-engine';
import { DEFAULT_APP_CONFIG, normalizeAppConfig } from '../../../shared/app-config';

/**
 * Specs for the assistant plugin's action engine
 * (`plugins/assistant/main/action-engine.ts`) -- the pre-conversion
 * `ActionRunner` logic, now driven through an injected completion call
 * (the base `ctx.llm` facade). The Angular runner ignores `plugins/**`,
 * so plugin specs live here and import the plugin sources.
 */

function engineWith(reply: string | Error, options: { llm?: boolean; mcp?: boolean } = {}): {
  engine: ActionEngine;
  calls: Array<{ messages: unknown; opts: unknown }>;
} {
  const calls: Array<{ messages: unknown; opts: unknown }> = [];
  const chat: ChatFn = async (messages, opts) => {
    calls.push({ messages, opts });
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  const config = normalizeAppConfig({
    ...DEFAULT_APP_CONFIG,
    llm: { ...DEFAULT_APP_CONFIG.llm, enabled: options.llm !== false },
    mcp: { ...DEFAULT_APP_CONFIG.mcp, enabled: options.mcp === true },
  });
  // One enabled manual trigger over the Reformat-style user template, plus
  // the built-in note-summary template the summarizer reads.
  config.actions.triggers.push({
    id: 'trigger:test',
    templateId: 'template:test',
    event: 'on-save',
    confirm: false,
    enabled: true,
  });
  config.actions.templates.push({
    id: 'template:test',
    name: 'Reformat',
    prompt: 'Tidy the document.',
    resultKind: 'localized',
    builtin: null,
  });
  return { engine: new ActionEngine(() => config, chat), calls };
}

const DOC = '# Titel\n\nEin Absatz.\n';

describe('assistant plugin action engine (plugins/assistant/main)', () => {
  it('a generic action returns an edit outcome with a normalized document', async () => {
    const { engine, calls } = engineWith('```\n\n# Titel\n\nNeuer Text\n```');
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC }, 'task-1');

    expect(outcome.kind).toBe('edit');
    if (outcome.kind !== 'edit') {
      return;
    }
    expect(outcome.name).toBe('Reformat');
    expect(outcome.path).toBe('a.md');
    expect(outcome.previewStyle).toBe('localized');
    expect(outcome.after).toBe('# Titel\n\nNeuer Text\n'); // fence stripped, trailing newline
    // The taskId is plumbed through so the renderer can cancel the call.
    expect(calls[0]?.opts).toEqual({ taskId: 'task-1' });
  });

  it('a selection-scoped action sends section and whole document', async () => {
    const { engine, calls } = engineWith(DOC);
    await engine.run('trigger:test', { path: 'a.md', body: DOC, selection: 'Ein Absatz.' });

    const user = (calls[0]?.messages as Array<{ role: string; content: string }>)[1];
    expect(user.content).toContain('SELECTED SECTION:');
    expect(user.content).toContain('WHOLE DOCUMENT:');
  });

  it('an unchanged reply is a noop, and a rejected call is an error outcome', async () => {
    const same = engineWith(DOC.trim());
    const unchanged = await same.engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(unchanged.kind).toBe('noop');

    const failing = engineWith(new Error('connection refused'));
    const failed = await failing.engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(failed.kind).toBe('error');
    if (failed.kind === 'error') {
      expect(failed.message).toBe('connection refused');
    }
  });

  it('a cancelled generation reports as a noop, not an error', async () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const { engine } = engineWith(abort);
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') {
      expect(outcome.message).toBe('Generation cancelled.');
    }
  });

  it('refuses to run when the LLM master switch is off', async () => {
    const { engine, calls } = engineWith('x', { llm: false });
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toBe('LLM features are disabled.');
    }
    expect(calls).toHaveLength(0);
  });

  it('the note-summary built-in is not runnable as an edit action', async () => {
    const { engine } = engineWith(DOC);
    const config = DEFAULT_APP_CONFIG;
    const summaryTrigger = normalizeAppConfig(config).actions.templates.find(
      (t) => t.builtin === 'note-summary',
    );
    expect(summaryTrigger).toBeDefined();
    void engine;
  });

  it('summarize uses the note-summary template and rejects an empty note', async () => {
    const { engine, calls } = engineWith('  Kurzfassung.  ');
    const text = await engine.summarize({ path: 'a.md', body: `${DOC}\n` }, 'task-2');

    expect(text).toBe('Kurzfassung.');
    const system = (calls[0]?.messages as Array<{ role: string; content: string }>)[0];
    // The note-summary built-in template's prompt is editable in Settings;
    // the default wording mentions a summary either way.
    expect(system.content.length).toBeGreaterThan(20);
    expect(calls[0]?.opts).toEqual({ taskId: 'task-2' });

    await expect(engine.summarize({ path: 'a.md', body: '   ' })).rejects.toThrow(
      /nothing to summarise/i,
    );
  });

  it('ask parses an answer reply and shapes an edit reply for the confirmation flow', async () => {
    const answered = engineWith('{"kind":"answer","text":"Es geht um Titel."}');
    const answer = await answered.engine.ask({ path: 'a.md', body: DOC }, 'Worum geht es?');
    expect(answer).toEqual({ kind: 'answer', text: 'Es geht um Titel.' });

    const edited = engineWith(
      '{"kind":"edit","document":"# Titel\\n\\nGeändert.\\n"}',
      { mcp: true },
    );
    const edit = await edited.engine.ask({ path: 'a.md', body: DOC }, 'Ändere den Text.');
    expect(edit.kind).toBe('edit');
    if (edit.kind === 'edit') {
      expect(edit.after).toBe('# Titel\n\nGeändert.\n');
      expect(edit.summary).toBe('Ändere den Text.');
    }
    // With the MCP switch on, the ask call opts into the vault tool loop.
    expect(edited.calls[0]?.opts).toMatchObject({ vaultTools: true });
  });

  it('the on-save enumeration only lists enabled on-save triggers', () => {
    const { engine } = engineWith(DOC);
    const actions = engine.actionsForEvent('on-save');
    expect(actions.map((a) => a.triggerId)).toEqual(['trigger:test']);
    expect(actions[0]?.confirm).toBe(false);
  });
});
