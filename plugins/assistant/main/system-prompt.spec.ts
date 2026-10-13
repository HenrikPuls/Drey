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

  it('states the write rule of each writing group', () => {
    const confirm = prompt({
      tools: { vault: { read: true, write: 'confirm' }, templates: { write: 'auto' } },
    });

    expect(confirm).toContain('The user confirms every vault_write in a diff dialog');
    expect(confirm).toContain(
      'A template_write or template_delete applies immediately without confirmation',
    );
  });

  it('keeps the open document out of vault_write while the fence protocol is in use', () => {
    const tools = { vault: { read: true, write: 'confirm' as const } };

    expect(prompt({ tools })).toContain('Never use vault_write on the DOCUMENT');
    expect(prompt({ mode: 'answer', tools })).not.toContain('Never use vault_write on the DOCUMENT');
  });

  it('drops the read tools from the list when the scope dropped them', () => {
    const text = prompt({
      tools: { vault: { read: false, write: 'confirm' }, explore: true },
      scopeVaultIds: ['docs'],
    });

    expect(text).toContain('- vault_write —');
    expect(text).not.toContain('vault_search');
    expect(text).toContain('- vault_overview, vault_find, vault_section');
  });

  it('lists every vault id with the active-vault hint when unscoped', () => {
    const text = prompt({ tools: { vault: { read: true, write: 'confirm' } } });

    expect(text).toContain('omit it for the active vault');
    expect(text).toContain('- test (TestVault) — active');
    expect(text).toContain('- docs (Docs)');
  });

  it('shrinks the id list to the scope and demands an id when the active vault is outside it', () => {
    const text = prompt({
      tools: { vault: { read: false, write: 'confirm' } },
      scopeVaultIds: ['docs'],
    });

    expect(text).toContain('always pass one of these ids');
    expect(text).toContain('- docs (Docs)');
    expect(text).not.toContain('- test (TestVault)');
  });

  it('lists no vault ids without the vault tools', () => {
    expect(prompt({ tools: { tasks: true } })).not.toContain('Vault ids for');
  });

  it('binds "the vault" to the scope and names only the sources that exist', () => {
    const both = prompt({
      scopeVaultIds: ['docs'],
      contextBlock: 'VAULT CONTEXT — …',
      tools: { explore: true },
    });
    const contextOnly = prompt({ scopeVaultIds: ['docs'], contextBlock: 'VAULT CONTEXT — …' });
    const neither = prompt({ scopeVaultIds: ['test', 'docs'] });

    expect(both).toContain('The vault for this question: Docs (`docs`).');
    expect(both).toContain('only from the vault context below and the vault exploration tools');
    expect(contextOnly).toContain('only from the vault context below,');
    expect(contextOnly).not.toContain('exploration tools');
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
