import { describe, expect, it } from 'vitest';
import { ASK_ANSWER_SYSTEM, ASK_SYSTEM } from './ask-prompts';
import { LIVE_EDIT_SYSTEM } from './live-edit';
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
    expect(prompt({ mode: 'live' }).startsWith(LIVE_EDIT_SYSTEM)).toBe(true);
    expect(prompt({})).toContain('Today is 2026-10-13 (Tuesday).');
  });

  it('names no tool and no tool rule when nothing is attached', () => {
    const text = prompt({});

    expect(text).not.toContain('You can call these tools');
    expect(text).not.toContain(TOOL_RULES);
    expect(text).not.toMatch(/vault_|tasks_list|template_|web_fetch/);
    expect(text).toContain(LINKS_RULE);
  });

  it('lists exactly the attached tools, then the rules', () => {
    const text = prompt({ tools: { tasks: true, external: true } });

    expect(text).toContain('- tasks_list');
    expect(text).toContain('- web_fetch');
    expect(text).not.toContain('vault_search');
    expect(text).not.toContain('template_list');
    expect(text.indexOf('You can call these tools')).toBeLessThan(text.indexOf(TOOL_RULES));
  });

  const READ_ONLY = { vault: { write: 'off' as const, retrieve: false } };
  const CONFIRM = { vault: { write: 'confirm' as const, retrieve: false } };

  it('names the reading tools, and vault_retrieve only while retrieval is on', () => {
    const without = prompt({ tools: READ_ONLY, scopeVaultIds: ['test'] });
    const withRetrieve = prompt({
      tools: { vault: { write: 'off', retrieve: true } },
      scopeVaultIds: ['test'],
    });

    expect(without).toContain('- vault_list, vault_search, vault_read —');
    expect(without).not.toContain('vault_retrieve');
    expect(withRetrieve).toContain('- vault_list, vault_search, vault_retrieve, vault_read —');
    expect(withRetrieve).toContain('find sections by meaning');
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
      tools: { vault: { write: 'auto', retrieve: false } },
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
    const text = prompt({ mode: 'live' });

    expect(text).toContain(TOOL_RULES);
    expect(text).not.toContain(LINKS_RULE);
  });
});
