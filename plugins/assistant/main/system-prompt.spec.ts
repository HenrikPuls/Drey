import { describe, expect, it } from 'vitest';
import { ASK_ANSWER_SYSTEM, ASK_SYSTEM, askToolsSystem, liveEditSystem } from './ask-prompts';
import {
  LINKS_RULE,
  SystemPromptInput,
  TOOL_RULES,
  buildSystemPrompt,
} from './system-prompt';

const VAULTS = [
  { id: 'test', name: 'TestVault', active: true },
  { id: 'docs', name: 'Docs', active: false },
] as const;

const BASE: SystemPromptInput = {
  mode: 'ask',
  tools: {},
  vaults: VAULTS,
  scopeVaultIds: null,
  contextBlock: null,
  now: new Date(2026, 9, 13),
};

const prompt = (over: Partial<SystemPromptInput>): string => buildSystemPrompt({ ...BASE, ...over });

describe('buildSystemPrompt', () => {
  it('opens with the role of the mode and always carries the date', () => {
    expect(prompt({})).toMatch(new RegExp(`^${ASK_SYSTEM.slice(0, 40)}`));
    expect(prompt({ mode: 'answer' }).startsWith(ASK_ANSWER_SYSTEM)).toBe(true);
    expect(
      prompt({ mode: 'live', document: { path: 'a.md', write: 'auto' } }).startsWith(
        liveEditSystem('a.md'),
      ),
    ).toBe(true);
    expect(prompt({})).toContain('Today is 2026-10-13 (Tuesday).');
  });

  it('names no tool and no tool rule when nothing is attached', () => {
    const text = prompt({});

    expect(text).not.toContain('You can call these tools');
    expect(text).not.toContain(TOOL_RULES);
    expect(text).not.toMatch(/vault_|tasks_list|template_|web_fetch|web_search|mcp__/);
    expect(text).toContain(LINKS_RULE);
  });

  it('lists exactly the attached tools, then the rules', () => {
    const text = prompt({
      tools: { tasks: true, external: { webSearch: false, webFetch: true, servers: false } },
    });

    expect(text).toContain('- tasks_list');
    expect(text).toContain('- web_fetch — what reaches outside the vault. Use it when');
    expect(text).not.toContain('web_search');
    expect(text).not.toContain('mcp__');
    expect(text).not.toContain('vault_search');
    expect(text).not.toContain('template_list');
    expect(text.indexOf('You can call these tools')).toBeLessThan(text.indexOf(TOOL_RULES));
  });

  it('names of the external tools only those that are switched on', () => {
    const line = (external: { webSearch: boolean; webFetch: boolean; servers: boolean }): string =>
      prompt({ tools: { external } })
        .split('\n')
        .find((entry) => entry.includes('what reaches outside the vault')) ?? '';

    expect(line({ webSearch: true, webFetch: true, servers: true })).toMatch(
      /^- web_search, web_fetch and tools named mcp__<server>__<tool> — .*read a page with web_fetch before you rely on it\. Use them when/,
    );
    const searchOnly = line({ webSearch: true, webFetch: false, servers: false });
    expect(searchOnly).toMatch(/^- web_search — .*returns short excerpts only.* Use it when/);
    expect(searchOnly).not.toContain('web_fetch');
    const serversOnly = line({ webSearch: false, webFetch: false, servers: true });
    expect(serversOnly).toMatch(/^- tools named mcp__<server>__<tool> — what reaches outside the vault\. Use them when/);
    expect(serversOnly).not.toMatch(/web_search|web_fetch/);
  });

  const READ_ONLY = { vault: { write: 'off' as const } };
  const CONFIRM = { vault: { write: 'confirm' as const } };

  it('names the reading tools', () => {
    const text = prompt({ tools: READ_ONLY, scopeVaultIds: ['test'] });

    expect(text).toContain('- vault_list, vault_search, vault_read —');
  });

  it('says that nothing can be changed while writing is off', () => {
    const text = prompt({ tools: READ_ONLY, scopeVaultIds: ['test'] });

    expect(text).toContain('You cannot change files in the vault in this conversation.');
    expect(text).not.toContain('vault_edit');
  });

  it('states the write rule of each writing group', () => {
    const confirm = prompt({
      tools: { ...CONFIRM, templates: { write: 'auto' } },
      scopeVaultIds: ['test'],
    });
    const auto = prompt({
      tools: { vault: { write: 'auto' } },
      scopeVaultIds: ['test'],
    });

    expect(confirm).toContain('- vault_edit, vault_write, vault_move, vault_delete —');
    expect(confirm).toContain('The user confirms every change in a dialog before it is applied.');
    expect(confirm).toContain(
      'A template_write or template_delete applies immediately without confirmation',
    );
    expect(auto).toContain('Changes apply immediately without confirmation');
    expect(auto).toContain('A deletion is always confirmed by the user.');
  });

  it('keeps the open document out of the changing tools while the fence protocol is in use', () => {
    expect(prompt({ tools: CONFIRM, scopeVaultIds: ['test'] })).toContain(
      'Never use them on the DOCUMENT of this conversation',
    );
    expect(prompt({ mode: 'answer', tools: CONFIRM, scopeVaultIds: ['test'] })).not.toContain(
      'Never use them on the DOCUMENT',
    );
  });

  it('points from the vault context to the tools, or tells to search first', () => {
    const withContext = prompt({
      tools: READ_ONLY,
      scopeVaultIds: ['test'],
      contextBlock: 'VAULT CONTEXT — …',
    });
    const without = prompt({ tools: READ_ONLY, scopeVaultIds: ['test'] });

    expect(withContext).toContain('The vault context above is a first selection');
    expect(without).toContain('Search first, then read what you found before you answer.');
  });

  it('explains the vault argument only when several vaults are in scope', () => {
    const one = prompt({ tools: READ_ONLY, scopeVaultIds: ['docs'] });
    const both = prompt({ tools: READ_ONLY, scopeVaultIds: ['test', 'docs'] });
    const twoWithoutActive = buildSystemPrompt({
      ...BASE,
      tools: READ_ONLY,
      vaults: [...VAULTS, { id: 'third', name: 'Third', active: false }],
      scopeVaultIds: ['docs', 'third'],
    });

    expect(one).not.toContain('`vault` argument');
    expect(both).toContain('leave it out to list or search all of them');
    expect(both).toContain('it defaults to the active vault (`test`)');
    expect(both).toContain('Results name a file as `id:path`');
    expect(twoWithoutActive).toContain('for a single file always pass it');
  });

  it('binds "the vault" to the scope and names only the sources that exist', () => {
    const both = prompt({
      scopeVaultIds: ['docs'],
      contextBlock: 'VAULT CONTEXT — …',
      tools: READ_ONLY,
    });
    const contextOnly = prompt({ scopeVaultIds: ['docs'], contextBlock: 'VAULT CONTEXT — …' });
    const neither = prompt({ scopeVaultIds: ['test', 'docs'] });

    expect(both).toContain('The vault for this question: Docs (`docs`).');
    expect(both).toContain('only from the vault context below and the vault tools');
    expect(contextOnly).toContain('only from the vault context below,');
    expect(contextOnly).not.toContain('vault tools');
    expect(neither).toContain('means exactly these vaults and nothing else.');
  });

  it('puts the retrieved context before the tools, so the task rule is the later instruction', () => {
    const text = prompt({ contextBlock: 'VAULT CONTEXT — block', tools: { tasks: true } });

    expect(text.indexOf('VAULT CONTEXT — block')).toBeLessThan(text.indexOf('- tasks_list'));
  });

  it('gives a live turn the rules but not the wikilink rule', () => {
    const text = prompt({ mode: 'live', document: { path: 'a.md', write: 'auto' } });

    expect(text).toContain(TOOL_RULES);
    expect(text).not.toContain(LINKS_RULE);
    expect(text).toContain('Every change appears in the user\'s editor the moment you make it');
    expect(text).not.toContain('doc_');
  });

  describe('the document changed with the vault tools (milestone 78)', () => {
    const DOCUMENT = { path: 'notes/plan.md', write: 'confirm' } as const;

    it('replaces the whole-document reply form with vault_edit', () => {
      const text = prompt({ document: DOCUMENT });

      expect(text.startsWith(askToolsSystem('notes/plan.md', 'confirm'))).toBe(true);
      expect(text).toContain('call vault_edit with the document\'s path');
      expect(text).toContain('confirms it before it is applied');
      expect(text).not.toContain('````document');
      expect(text).toContain(TOOL_RULES);
    });

    it('says when a change applies without the dialog', () => {
      const text = prompt({ document: { path: 'notes/plan.md', write: 'auto' } });

      expect(text).toContain('applied to the document at once');
      expect(text).not.toContain('confirms it before it is applied');
    });

    it('with the Vault chip off the tools reach the document only', () => {
      const text = prompt({ document: DOCUMENT });

      expect(text).toContain(
        '- vault_read, vault_edit, vault_write — they reach only the document of this conversation (`notes/plan.md`)',
      );
      expect(text).not.toContain('vault_search');
    });

    it('with the chip on the vault tools are listed, without the fence warning', () => {
      const text = prompt({ document: DOCUMENT, tools: CONFIRM, scopeVaultIds: ['test'] });

      expect(text).toContain('- vault_list, vault_search');
      expect(text).not.toContain('Never use them on the DOCUMENT');
      expect(text).not.toContain('they reach only the document');
    });

    it('a vault that may not be written still leaves the document changeable', () => {
      const text = prompt({ document: DOCUMENT, tools: READ_ONLY, scopeVaultIds: ['test'] });

      expect(text).toContain(
        'Apart from the document of this conversation you cannot change files in the vault.',
      );
    });

    it('a call without a tool loop keeps the whole-document reply form', () => {
      const text = prompt({});

      expect(text).toContain('````document');
      expect(text).not.toContain('vault_edit');
    });
  });
});
