import { describe, expect, it } from 'vitest';
import { ActionEngine } from './action-engine';
import { DEFAULT_ACTIONS_CONFIG } from '../../../shared/app-config';
import type { ChatMessage } from '../../../shared/llm';

/**
 * The generic action path, with the built-in lossless "Structure note"
 * template as the carrier: the system prompt is the template with
 * `{{AVAILABLE_TAGS}}` substituted from the injected vocabulary plus the
 * document-rewrite suffix; the note itself rides the user message.
 */

describe('ActionEngine prompt assembly', () => {
  const context = { path: 'note.md', body: '# Title\n\nraw text\n' };

  function captureEngine(vocabulary: readonly string[], reply: string) {
    const messages: ChatMessage[] = [];
    // The plugin's own `actions` config value — the defaults carry the
    // lossless template + its manual trigger. `llmEnabled` gates the run.
    const engine = new ActionEngine(
      () => DEFAULT_ACTIONS_CONFIG,
      () => true,
      async (sent) => {
        messages.push(...sent);
        return reply;
      },
      () => vocabulary,
    );
    return { engine, messages };
  }

  it('substitutes {{AVAILABLE_TAGS}} into the lossless template; task filtered, suffix appended', async () => {
    const { engine, messages } = captureEngine(
      ['sailing', 'task', 'project/boat'],
      '# Title\n\nstructured\n',
    );
    const outcome = await engine.run('trigger:lossless-format', context);

    expect(outcome.kind).toBe('edit');
    expect(outcome).toMatchObject({ summary: 'Structure note (lossless)', previewStyle: 'document' });

    const [system, user] = messages;
    expect(system.role).toBe('system');
    // The vocabulary block arrived substituted: the tags are there, the
    // token is gone, and the reserved #task is never offered.
    expect(system.content).toContain('AVAILABLE_TAGS:\nsailing\nproject/boat');
    expect(system.content).not.toContain('{{AVAILABLE_TAGS}}');
    expect(system.content).not.toContain('\ntask\n');
    // The generic document-rewrite suffix rides along.
    expect(system.content).toContain('Return the complete, revised Markdown document');
    // The note rides the user message, never the system prompt.
    expect(user.content).toBe(context.body);
  });

  it("substitutes '(none yet)' when no vocabulary is available (no provider registered)", async () => {
    const { engine, messages } = captureEngine([], '# Title\n\nstructured\n');
    await engine.run('trigger:lossless-format', context);
    expect(messages[0].content).toContain('AVAILABLE_TAGS:\n(none yet)');
  });

  it('reports a noop when the model returns the document unchanged', async () => {
    const { engine } = captureEngine(['sailing'], context.body);
    const outcome = await engine.run('trigger:lossless-format', context);
    expect(outcome.kind).toBe('noop');
  });
});
