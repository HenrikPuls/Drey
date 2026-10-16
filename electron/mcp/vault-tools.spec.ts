import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isLocalHost, isLocalOrigin } from './http-transport';
import { createVaultMcpServer } from './server';
import { VaultTools } from './vault-tools';
import type { VaultCallOptions, VaultToolDeps } from './vault-tools';
import type { OpenDocs } from './tools/types';
import type { AppConfig } from '../../shared/app-config';
import type { RenameLinksRequest, VaultFileEntry } from '../../shared/ipc-api';
import type {
  SectionSearchProvider,
  SdkTaskRecord,
} from '../../shared/plugin-api';

/**
 * `electron/mcp/` is transport- and IO-free at its core (ADR-0007 keeps
 * the fragile logic out of the main process shell), so it is unit-tested
 * here like the other cross-layer modules -- over an in-memory vault
 * registry and fake providers.
 */

function config(overrides: Partial<AppConfig['mcp']> = {}): AppConfig {
  return {
    mcp: { enabled: true, httpEnabled: false, httpPort: 4319, yolo: false, ...overrides },
  } as AppConfig;
}

describe('the vault MCP server (SDK protocol layer)', () => {
  const tools = {
    list: () => [
      { name: 'vault_read', description: 'x', inputSchema: { type: 'object', properties: {} } },
    ],
    call: async (name: string, args: Record<string, unknown>) =>
      name === 'vault_read'
        ? { content: [{ type: 'text' as const, text: `${name}:${JSON.stringify(args)}` }] }
        : { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true },
  };

  async function connected(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createVaultMcpServer(tools as unknown as VaultTools, '9.9.9').connect(serverSide);
    const client = new Client({ name: 'spec', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
    return client;
  }

  it('introduces itself and offers tools only', async () => {
    const client = await connected();
    expect(client.getServerVersion()).toMatchObject({ name: 'drey-vault', version: '9.9.9' });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  });

  it('lists tools and runs a tools/call through VaultTools', async () => {
    const client = await connected();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['vault_read']);
    const result = await client.callTool({ name: 'vault_read', arguments: { path: 'a.md' } });
    expect(result.content).toEqual([{ type: 'text', text: 'vault_read:{"path":"a.md"}' }]);
  });

  it('passes a tool error through as an error result', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe('the HTTP endpoint guards', () => {
  it('accepts only a local Host on its own port', () => {
    expect(isLocalHost('127.0.0.1:4319', 4319)).toBe(true);
    expect(isLocalHost('localhost:4319', 4319)).toBe(true);
    expect(isLocalHost('localhost:9999', 4319)).toBe(false);
    expect(isLocalHost('evil.example', 4319)).toBe(false);
    expect(isLocalHost('evil.example:4319', 4319)).toBe(false);
    expect(isLocalHost(undefined, 4319)).toBe(false);
  });

  it('accepts no Origin (not a browser) or a local page, nothing else', () => {
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('https://evil.example')).toBe(false);
    expect(isLocalOrigin('http://localhost.evil.example')).toBe(false);
    expect(isLocalOrigin('null')).toBe(false);
  });
});

/** A vault registry of two vaults over in-memory files, recording what the tools did to it. */
function harness(
  files: Record<string, Record<string, string>> = {},
  over: Partial<VaultToolDeps> & { yolo?: boolean; active?: string } = {},
) {
  const store: Record<string, Record<string, string>> = { vtest: {}, docs: {}, ...files };
  const names: Record<string, string> = { vtest: 'Test Vault', docs: 'Docs' };
  const writes: Array<{ vaultId: string; path: string; content: string; origin?: string }> = [];
  const deleted: Array<{ vaultId: string; path: string }> = [];
  const announced: Array<{ vaultId: string; changedPaths: string[]; deletedPaths: string[] }> = [];
  const refreshed: string[] = [];
  const renames: RenameLinksRequest[] = [];
  const confirms: Array<Parameters<VaultToolDeps['confirmWrite']>[0]> = [];
  const approvals: Array<Parameters<VaultToolDeps['approve']>[0]> = [];
  let confirmAnswer = true;
  let approveAnswer = true;

  const filesOf = (vaultId?: string): Record<string, string> => store[vaultId ?? over.active ?? 'vtest'] ?? {};
  const tree = (paths: string[]): VaultFileEntry[] => {
    const root: VaultFileEntry[] = [];
    for (const path of [...paths].sort()) {
      const parts = path.split('/');
      let level = root;
      parts.forEach((part, i) => {
        const relativePath = parts.slice(0, i + 1).join('/');
        if (i === parts.length - 1) {
          level.push({ name: part, relativePath, type: 'file' });
          return;
        }
        let dir = level.find((entry) => entry.type === 'directory' && entry.name === part);
        if (dir === undefined) {
          dir = { name: part, relativePath, type: 'directory', children: [] };
          level.push(dir);
        }
        level = dir.children!;
      });
    }
    return root;
  };

  const vault: VaultToolDeps['vault'] = {
    listVaults: () =>
      Object.keys(store).map((id) => ({
        id,
        name: names[id] ?? id,
        path: `/vaults/${id}`,
        exists: true,
        active: id === (over.active ?? 'vtest'),
      })) as never,
    getActiveVaultId: () => over.active ?? 'vtest',
    listFiles: async (vaultId) => tree(Object.keys(filesOf(vaultId))),
    listMarkdownFiles: async (vaultId) =>
      Object.keys(filesOf(vaultId))
        .filter((path) => path.endsWith('.md'))
        .sort(),
    readFile: async (path, vaultId) => {
      const content = filesOf(vaultId)[path];
      if (content === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return { content, modifiedMs: 1 };
    },
    writeFile: async (path, content, vaultId, opts) => {
      filesOf(vaultId)[path] = content;
      writes.push({ vaultId: vaultId ?? 'vtest', path, content, ...(opts?.origin ? { origin: opts.origin } : {}) });
      return 2;
    },
    deleteEntry: async (path, vaultId) => {
      delete filesOf(vaultId)[path];
      deleted.push({ vaultId: vaultId ?? 'vtest', path });
      return { trashed: true };
    },
  };

  const deps: VaultToolDeps = {
    vault,
    getSearchProvider: () => null,
    getTaskProvider: () => null,
    getConfig: () => config({ yolo: over.yolo ?? false }),
    confirmWrite: async (request) => {
      confirms.push(request);
      return confirmAnswer;
    },
    approve: async (request) => {
      approvals.push(request);
      return approveAnswer;
    },
    rename: async (request) => {
      renames.push(request);
      const vaultFiles = filesOf(request.fromVaultId);
      if (!(request.fromRel in vaultFiles)) {
        throw new Error(`Not found: ${request.fromRel}`);
      }
      vaultFiles[request.toRel] = vaultFiles[request.fromRel];
      delete vaultFiles[request.fromRel];
      return { path: request.toRel, written: ['index.md'], buffers: [], assets: [], failed: [] };
    },
    announce: (changes) => announced.push(changes),
    announceRefresh: (vaultId) => refreshed.push(vaultId),
    ...over,
  };
  const tools = new VaultTools(deps);
  const run = async (
    name: string,
    args: Record<string, unknown>,
    options?: VaultCallOptions,
  ): Promise<{ text: string; isError: boolean }> => {
    const result = await tools.call(name, args, options);
    return { text: result.content.map((block) => block.text).join('\n'), isError: result.isError === true };
  };
  return {
    tools,
    run,
    store,
    writes,
    deleted,
    announced,
    refreshed,
    renames,
    confirms,
    approvals,
    decline: () => {
      confirmAnswer = false;
      approveAnswer = false;
    },
  };
}

const HARBOUR = ['# Harbour', '', 'The harbour fee is 12 euros per night.', '', '## Winter', '', 'Take the mast down before the first frost.', ''].join('\n');

describe('VaultTools — what a caller is offered', () => {
  it('offers every tool to an MCP client', () => {
    const h = harness();
    expect(h.tools.list().map((tool) => tool.name)).toEqual([
      'vault_list',
      'vault_search',
      'vault_read',
      'vault_edit',
      'vault_write',
      'vault_move',
      'vault_delete',
      'tasks_list',
    ]);
  });

  it('leaves the changing tools and tasks_list out of the assistant set when writing is off', () => {
    const h = harness();
    expect(h.tools.toolSpecs({ write: 'off' }).map((tool) => tool.name)).toEqual([
      'vault_list',
      'vault_search',
      'vault_read',
    ]);
    expect(h.tools.toolSpecs({ write: 'confirm' }).map((tool) => tool.name)).not.toContain(
      'tasks_list',
    );
  });

  it('refuses an unknown tool', async () => {
    expect(await harness().run('vault_wipe', {})).toEqual({
      text: 'Error: there is no tool "vault_wipe".',
      isError: true,
    });
  });
});

describe('VaultTools — scope', () => {
  const files = { vtest: { 'a.md': 'alpha in test' }, docs: { 'a.md': 'alpha in docs' } };

  it('reads from the active vault by default and from a named one on request', async () => {
    const h = harness(files);
    expect((await h.run('vault_read', { path: 'a.md' })).text).toContain('1: alpha in test');
    expect((await h.run('vault_read', { path: 'a.md', vault: 'docs' })).text).toContain(
      '1: alpha in docs',
    );
  });

  it('takes apart a `vault:path` label as results print it', async () => {
    const h = harness(files);
    expect((await h.run('vault_read', { path: 'docs:a.md' })).text).toContain('1: alpha in docs');
  });

  it('refuses a vault outside the scope and names the ones inside', async () => {
    const h = harness(files);
    const result = await h.run('vault_read', { path: 'a.md', vault: 'vtest' }, { scope: ['docs'] });
    expect(result).toEqual({
      text: 'Error: vault "vtest" is not available to this call. Pass one of: "docs" (Docs).',
      isError: true,
    });
  });

  it('uses the only vault in scope without being told, even when another one is active', async () => {
    const h = harness(files);
    expect((await h.run('vault_read', { path: 'a.md' }, { scope: ['docs'] })).text).toContain(
      '1: alpha in docs',
    );
  });

  it('asks for the vault when several are in scope and the active one is not among them', async () => {
    const h = harness({ ...files, third: { 'a.md': 'x' } }, { active: 'vtest' });
    const result = await h.run('vault_read', { path: 'a.md' }, { scope: ['docs', 'third'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('pass the "vault" argument');
  });

  it('does not write outside the scope', async () => {
    const h = harness(files);
    const result = await h.run(
      'vault_write',
      { path: 'new.md', content: 'x', mode: 'create', vault: 'vtest' },
      { scope: ['docs'], write: 'auto' },
    );
    expect(result.isError).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it('searches every vault in scope and labels the hits', async () => {
    const h = harness(files);
    const result = await h.run('vault_search', { query: 'alpha' });
    expect(result.text).toContain('vtest:a.md');
    expect(result.text).toContain('docs:a.md');
    const scoped = await h.run('vault_search', { query: 'alpha' }, { scope: ['docs'] });
    expect(scoped.text).not.toContain('alpha in test');
    // One vault in play: bare paths.
    expect(scoped.text).toContain('\na.md\n');
  });
});

describe('vault_list', () => {
  const files = {
    vtest: {
      'index.md': '# Index',
      'notes/harbour.md': HARBOUR,
      'notes/pic.png': 'binary',
      'chats/2026/10/c.md': '# Chat',
      'daily/2026-10-13.md': '# Day',
    },
  };

  it('lists the files of a vault, a folder, or a name pattern', async () => {
    const h = harness(files);
    const all = await h.run('vault_list', { vault: 'vtest' });
    expect(all.text).toContain('5 files in Test Vault (vtest):');
    expect((await h.run('vault_list', { vault: 'vtest', path: 'notes' })).text).toBe(
      ['2 files in Test Vault (vtest), notes/:', 'vtest:notes/harbour.md', 'vtest:notes/pic.png'].join('\n'),
    );
    expect((await h.run('vault_list', { glob: '*.png' }, { scope: ['vtest'] })).text).toBe(
      ['1 file in Test Vault:', 'notes/pic.png'].join('\n'),
    );
    expect((await h.run('vault_list', { glob: 'daily/2026-*' }, { scope: ['vtest'] })).text).toContain(
      'daily/2026-10-13.md',
    );
  });

  it('shows the headings of each note with their line numbers', async () => {
    const h = harness(files);
    const result = await h.run('vault_list', { path: 'notes', headings: true }, { scope: ['vtest'] });
    expect(result.text).toContain(['notes/harbour.md', '  1: # Harbour', '  5: ## Winter'].join('\n'));
  });

  it("hides the app's own folders from the assistant", async () => {
    const h = harness(files);
    const result = await h.run('vault_list', {}, { scope: ['vtest'], protectAppFolders: true });
    expect(result.text).not.toContain('chats/');
    expect(result.text).toContain('4 files');
  });

  it('answers a long listing with folders and counts instead', async () => {
    const many: Record<string, string> = { 'readme.md': '' };
    for (let i = 0; i < 150; i++) {
      many[`daily/${i}.md`] = '';
      many[`projects/${i}.md`] = '';
    }
    const result = await harness({ vtest: many }).run('vault_list', {}, { scope: ['vtest'] });
    expect(result.text).toContain('301 files in Test Vault — too many to list. Folders:');
    expect(result.text).toContain('daily/ (150 files)');
    expect(result.text).toContain('projects/ (150 files)');
    expect(result.text).toContain('readme.md');
    expect(result.text).toContain('Call vault_list again with `path`');
  });

  it('says so when nothing is there', async () => {
    const result = await harness(files).run('vault_list', { path: 'nope' }, { scope: ['vtest'] });
    expect(result.text).toBe('No files in Test Vault, nope/.');
  });
});

describe('vault_search', () => {
  const files = {
    vtest: {
      'notes/harbour.md': HARBOUR,
      'notes/other.md': '# Other\n\nNothing about fees here.\n',
      'chats/c.md': 'the harbour fee again',
    },
  };
  const opts: VaultCallOptions = { scope: ['vtest'] };

  it('finds the sections that hold all words, with the lines that carry them', async () => {
    const result = await harness(files).run('vault_search', { query: 'fee euros' }, opts);
    expect(result.text).toContain('notes/harbour.md — Harbour');
    expect(result.text).toContain('  3: The harbour fee is 12 euros per night.');
    // "fees" alone is in other.md, "euros" is not: no hit there.
    expect(result.text).not.toContain('notes/other.md');
  });

  it('matches a quoted phrase as written', async () => {
    const h = harness(files);
    expect((await h.run('vault_search', { query: '"fee is 12"' }, opts)).text).toContain('3: The harbour fee');
    expect((await h.run('vault_search', { query: '"fee 12"' }, opts)).text).toMatch(/^No matches/);
  });

  it('searches inside one file when `path` names one', async () => {
    const result = await harness(files).run('vault_search', { query: 'mast', path: 'notes/harbour.md' }, opts);
    expect(result.text).toContain('notes/harbour.md — Winter');
    expect(result.text).toContain('  7: Take the mast down before the first frost.');
  });

  it('shows context lines around a hit', async () => {
    const result = await harness(files).run(
      'vault_search',
      { query: 'mast', path: 'notes/harbour.md', context_lines: 2 },
      opts,
    );
    expect(result.text).toContain(['  5- ## Winter', '  6- ', '  7: Take the mast down'].join('\n'));
  });

  it('matches a regular expression line by line, and names a broken one', async () => {
    const h = harness(files);
    const hit = await h.run('vault_search', { query: '\\d+ euros', regex: true }, opts);
    expect(hit.text).toContain('3: The harbour fee is 12 euros per night.');
    const broken = await h.run('vault_search', { query: '(', regex: true }, opts);
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain('not a valid regular expression');
  });

  it('respects upper and lower case only when asked', async () => {
    const h = harness(files);
    expect((await h.run('vault_search', { query: 'HARBOUR' }, opts)).text).toContain('notes/harbour.md');
    expect(
      (await h.run('vault_search', { query: 'HARBOUR', case_sensitive: true }, opts)).text,
    ).toMatch(/^No matches/);
  });

  it('stops at max_results and says how to narrow', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `fee ${i}`).join('\n');
    const result = await harness({ vtest: { 'a.md': lines } }).run(
      'vault_search',
      { query: 'fee \\d', regex: true, max_results: 4 },
      opts,
    );
    expect(result.text).toContain('4 matching lines');
    expect(result.text).toContain('[stopped at 4 lines — narrow with `path`');
  });

  it("leaves the app's own folders out for the assistant", async () => {
    const h = harness(files);
    expect((await h.run('vault_search', { query: 'again' }, opts)).text).toContain('chats/c.md');
    expect(
      (await h.run('vault_search', { query: 'again' }, { ...opts, protectAppFolders: true })).text,
    ).toMatch(/^No matches/);
  });

  it('says what to try when nothing matches, and needs a query or tags', async () => {
    const h = harness(files);
    expect((await h.run('vault_search', { query: 'zeppelin kite' }, opts)).text).toBe(
      'No matches for "zeppelin kite" in 3 files. Try other or fewer words (all of them must occur in one section).',
    );
    expect((await h.run('vault_search', {}, opts)).isError).toBe(true);
  });

  it('asks the section index for tags, and says so when it is unavailable', async () => {
    const provider: SectionSearchProvider = {
      search: async () =>
        [
          { path: 'notes/harbour.md', heading: 'Harbour', line: 1, snippet: 'The harbour fee…', text: 'fee' },
          { path: 'elsewhere/x.md', heading: 'X', line: 4, snippet: 'other', text: 'other' },
        ] as never[],
      vocabulary: () => [],
    };
    const h = harness(files, { getSearchProvider: () => provider });
    const result = await h.run('vault_search', { tags: ['#boat'], path: 'notes' }, opts);
    expect(result.text).toContain('1 section match #boat');
    expect(result.text).toContain('notes/harbour.md:1 — Harbour');
    expect(result.text).not.toContain('elsewhere');

    const without = await harness(files).run('vault_search', { tags: ['boat'] }, opts);
    expect(without.isError).toBe(true);
    expect(without.text).toContain('Tags plugin is switched off');
  });
});

describe('vault_read', () => {
  const opts: VaultCallOptions = { scope: ['vtest'] };

  it('numbers the lines and says the file is complete', async () => {
    const result = await harness({ vtest: { 'h.md': HARBOUR } }).run('vault_read', { path: 'h.md' }, opts);
    expect(result.text.split('\n').slice(0, 3)).toEqual(['1: # Harbour', '2: ', '3: The harbour fee is 12 euros per night.']);
    expect(result.text).toMatch(/\[h\.md — all 7 lines\]$/);
  });

  it('returns a range and how to continue', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const h = harness({ vtest: { 'long.md': long } });
    const part = await h.run('vault_read', { path: 'long.md', start_line: 11, line_count: 5 }, opts);
    expect(part.text).toBe(
      ['11: line 11', '12: line 12', '13: line 13', '14: line 14', '15: line 15', '[long.md — lines 11–15 of 50. Continue with start_line=16.]'].join('\n'),
    );
    const tail = await h.run('vault_read', { path: 'long.md', start_line: 49 }, opts);
    expect(tail.text).toMatch(/lines 49–50 of 50, the end of the file\.\]$/);
  });

  it('cuts a default read at 400 lines', async () => {
    const long = Array.from({ length: 900 }, (_, i) => `l${i + 1}`).join('\n');
    const result = await harness({ vtest: { 'long.md': long } }).run('vault_read', { path: 'long.md' }, opts);
    expect(result.text).toMatch(/lines 1–400 of 900\. Continue with start_line=401\.\]$/);
  });

  it('stops a range early when the lines are long, so the continuation survives', async () => {
    const wide = Array.from({ length: 100 }, () => 'x'.repeat(500)).join('\n');
    const result = await harness({ vtest: { 'wide.md': wide } }).run('vault_read', { path: 'wide.md' }, opts);
    expect(result.text.length).toBeLessThan(13_000);
    expect(result.text).toMatch(/Continue with start_line=\d+\.\]$/);
  });

  it('reads one section by its heading, sub-sections included', async () => {
    const h = harness({ vtest: { 'h.md': `${HARBOUR}\n# Next\n\nelse\n` } });
    const result = await h.run('vault_read', { path: 'h.md', heading: 'harbour' }, opts);
    expect(result.text).toContain('7: Take the mast down');
    expect(result.text).not.toContain('# Next');
    const sub = await h.run('vault_read', { path: 'h.md', heading: '## Winter' }, opts);
    expect(sub.text.startsWith('5: ## Winter')).toBe(true);
  });

  it('lists the headings when the one asked for is not there', async () => {
    const result = await harness({ vtest: { 'h.md': HARBOUR } }).run(
      'vault_read',
      { path: 'h.md', heading: 'Summer' },
      opts,
    );
    expect(result).toEqual({
      text: 'Error: no heading "Summer" in h.md. Its headings: "Harbour", "Winter".',
      isError: true,
    });
  });

  it('names a missing file, a start past the end and a file that is not text', async () => {
    const h = harness({ vtest: { 'h.md': HARBOUR, 'p.png': 'x' } });
    expect((await h.run('vault_read', { path: 'nope.md' }, opts)).text).toContain('there is no file "nope.md" in Test Vault');
    expect((await h.run('vault_read', { path: 'h.md', start_line: 99 }, opts)).text).toBe(
      'Error: h.md has only 7 lines — start_line 99 is past its end.',
    );
    expect((await h.run('vault_read', { path: 'p.png' }, opts)).text).toContain('not a text file');
  });
});

describe('vault_edit', () => {
  const auto: VaultCallOptions = { scope: ['vtest'], write: 'auto', origin: 'assistant' };
  const file = (): Record<string, Record<string, string>> => ({ vtest: { 'h.md': HARBOUR } });

  it('replaces exact text, writes, announces, and says where', async () => {
    const h = harness(file());
    const result = await h.run(
      'vault_edit',
      { path: 'h.md', edits: [{ old_text: '12 euros', new_text: '14 euros' }] },
      auto,
    );
    expect(result).toEqual({ text: 'Edited h.md: 1 replacement at line 3.', isError: false });
    expect(h.store['vtest']['h.md']).toContain('The harbour fee is 14 euros per night.');
    expect(h.writes[0]).toMatchObject({ vaultId: 'vtest', path: 'h.md', origin: 'assistant' });
    expect(h.announced).toEqual([{ vaultId: 'vtest', changedPaths: ['h.md'], deletedPaths: [] }]);
    expect(h.confirms).toEqual([]);
  });

  it('applies several edits in order, or none of them', async () => {
    const h = harness(file());
    const failed = await h.run(
      'vault_edit',
      {
        path: 'h.md',
        edits: [
          { old_text: '12 euros', new_text: '14 euros' },
          { old_text: 'no such text', new_text: 'x' },
        ],
      },
      auto,
    );
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Edit 2: old_text "no such text" was not found — nothing was changed.');
    expect(h.writes).toEqual([]);
    expect(h.store['vtest']['h.md']).toBe(HARBOUR);
  });

  it('refuses text that occurs more than once unless replace_all is set', async () => {
    const h = harness({ vtest: { 'a.md': 'fee\nfee\n' } });
    const ambiguous = await h.run('vault_edit', { path: 'a.md', edits: [{ old_text: 'fee', new_text: 'toll' }] }, auto);
    expect(ambiguous.text).toContain('occurs 2 times (lines 1, 2)');
    const all = await h.run(
      'vault_edit',
      { path: 'a.md', edits: [{ old_text: 'fee', new_text: 'toll', replace_all: true }] },
      auto,
    );
    expect(all.text).toBe('Edited a.md: 2 replacements at lines 1, 2.');
    expect(h.store['vtest']['a.md']).toBe('toll\ntoll\n');
  });

  it('keeps the CRLF line ends of a file', async () => {
    const h = harness({ vtest: { 'w.md': 'one\r\ntwo\r\n' } });
    await h.run('vault_edit', { path: 'w.md', edits: [{ old_text: 'one\ntwo', new_text: 'one\n2' }] }, auto);
    expect(h.store['vtest']['w.md']).toBe('one\r\n2\r\n');
  });

  it('shows the change first under "confirm", and writes nothing when declined', async () => {
    const h = harness(file());
    const edits = [{ old_text: '12 euros', new_text: '14 euros' }];
    await h.run('vault_edit', { path: 'h.md', edits }, { ...auto, write: 'confirm' });
    expect(h.confirms[0]).toMatchObject({ path: 'h.md', before: HARBOUR, vaultName: 'Test Vault', origin: 'assistant' });
    expect(h.writes).toHaveLength(1);

    const declined = harness(file());
    declined.decline();
    const result = await declined.run('vault_edit', { path: 'h.md', edits }, { ...auto, write: 'confirm' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the user declined this change');
    expect(declined.writes).toEqual([]);
  });

  it('follows mcp.yolo for a caller that names no rule', async () => {
    const edits = [{ old_text: '12 euros', new_text: '14 euros' }];
    const careful = harness(file());
    await careful.run('vault_edit', { path: 'h.md', edits });
    expect(careful.confirms).toHaveLength(1);
    const yolo = harness(file(), { yolo: true });
    await yolo.run('vault_edit', { path: 'h.md', edits });
    expect(yolo.confirms).toEqual([]);
    expect(yolo.writes[0]?.origin).toBe('mcp');
  });

  it('refuses when writing is off, when the file is missing, and in the app folders', async () => {
    const h = harness({ vtest: { 'h.md': HARBOUR, 'chats/c.md': 'chat' } });
    const edits = [{ old_text: 'chat', new_text: 'x' }];
    expect((await h.run('vault_edit', { path: 'h.md', edits }, { ...auto, write: 'off' })).text).toContain('switched off');
    expect((await h.run('vault_edit', { path: 'nope.md', edits }, auto)).text).toContain('there is no file "nope.md"');
    expect(
      (await h.run('vault_edit', { path: 'chats/c.md', edits }, { ...auto, protectAppFolders: true })).text,
    ).toContain('belongs to the app');
    expect(h.writes).toEqual([]);
  });

  it('names a malformed edit', async () => {
    const h = harness(file());
    expect((await h.run('vault_edit', { path: 'h.md', edits: [] }, auto)).text).toContain('non-empty array');
    expect((await h.run('vault_edit', { path: 'h.md', edits: [{ find: 'x' }] }, auto)).text).toContain(
      'edit 1 needs the strings "old_text" and "new_text"',
    );
  });
});

describe('vault_write', () => {
  const auto: VaultCallOptions = { scope: ['vtest'], write: 'auto' };

  it('creates a file, and refuses to create one that exists', async () => {
    const h = harness({ vtest: { 'a.md': 'old' } });
    expect((await h.run('vault_write', { path: 'new/b.md', content: 'one\ntwo', mode: 'create' }, auto)).text).toBe(
      'Created new/b.md (2 lines).',
    );
    const exists = await h.run('vault_write', { path: 'a.md', content: 'x', mode: 'create' }, auto);
    expect(exists.isError).toBe(true);
    expect(exists.text).toContain('a.md already exists — nothing was written');
    expect(h.store['vtest']['a.md']).toBe('old');
  });

  it('appends with a line break between, and creates the file when there is none', async () => {
    const h = harness({ vtest: { 'log.md': 'first' } });
    await h.run('vault_write', { path: 'log.md', content: 'second\n', mode: 'append' }, auto);
    expect(h.store['vtest']['log.md']).toBe('first\nsecond\n');
    await h.run('vault_write', { path: 'fresh.md', content: 'only', mode: 'append' }, auto);
    expect(h.store['vtest']['fresh.md']).toBe('only');
  });

  it('overwrites, and reports an unchanged file without writing', async () => {
    const h = harness({ vtest: { 'a.md': 'old' } });
    expect((await h.run('vault_write', { path: 'a.md', content: 'new', mode: 'overwrite' }, auto)).text).toBe(
      'Replaced the content of a.md (1 line).',
    );
    expect((await h.run('vault_write', { path: 'a.md', content: 'new', mode: 'overwrite' }, auto)).text).toBe(
      'No change — a.md already has this content.',
    );
    expect(h.writes).toHaveLength(1);
  });

  it('requires a mode — a missing or mistyped one never becomes an overwrite', async () => {
    const h = harness({ vtest: { 'a.md': 'old' } });
    for (const mode of [undefined, 'replace', 'Append']) {
      const result = await h.run('vault_write', { path: 'a.md', content: 'x', mode }, auto);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('needs `mode`');
    }
    expect(h.store['vtest']['a.md']).toBe('old');
  });

  it('shows an append as an append in the confirmation', async () => {
    const h = harness({ vtest: { 'log.md': 'first\n' } });
    await h.run('vault_write', { path: 'log.md', content: 'second', mode: 'append' }, { ...auto, write: 'confirm' });
    expect(h.confirms[0]).toMatchObject({ mode: 'append', before: 'first\n', after: 'first\nsecond' });
  });
});

describe('vault_move and vault_delete', () => {
  const files = (): Record<string, Record<string, string>> => ({
    vtest: { 'a.md': 'a', 'index.md': '[[a]]', 'chats/c.md': 'chat' },
  });

  it('moves through the link-keeping rename and refreshes the vault', async () => {
    const h = harness(files());
    const result = await h.run('vault_move', { from: 'a.md', to: 'archive/a.md' }, { scope: ['vtest'], write: 'auto' });
    expect(result.text).toBe('Moved a.md → archive/a.md. Links updated in 1 note.');
    expect(h.renames[0]).toMatchObject({ fromRel: 'a.md', toRel: 'archive/a.md', fromVaultId: 'vtest', toVaultId: 'vtest' });
    expect(h.refreshed).toEqual(['vtest']);
    expect(h.approvals).toEqual([]);
  });

  it('asks before a move under "confirm" and reports a failed rename', async () => {
    const h = harness(files());
    await h.run('vault_move', { from: 'a.md', to: 'b.md' }, { scope: ['vtest'], write: 'confirm' });
    expect(h.approvals[0]).toEqual({ tool: 'vault_move', args: { from: 'a.md', to: 'b.md', vault: 'Test Vault' } });
    const missing = await h.run('vault_move', { from: 'nope.md', to: 'x.md' }, { scope: ['vtest'], write: 'auto' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('could not move nope.md — Not found: nope.md');
  });

  it('asks before every deletion, whatever the write rule', async () => {
    const h = harness(files());
    const result = await h.run('vault_delete', { path: 'a.md' }, { scope: ['vtest'], write: 'auto' });
    expect(h.approvals).toEqual([{ tool: 'vault_delete', args: { path: 'a.md', vault: 'Test Vault' } }]);
    expect(result.text).toBe('Moved a.md to the recycle bin.');
    expect(h.deleted).toEqual([{ vaultId: 'vtest', path: 'a.md' }]);
    expect(h.announced.at(-1)).toEqual({ vaultId: 'vtest', changedPaths: [], deletedPaths: ['a.md'] });
  });

  it('deletes nothing when declined, when the file is missing, or in the app folders', async () => {
    const h = harness(files());
    h.decline();
    const opts: VaultCallOptions = { scope: ['vtest'], write: 'auto', protectAppFolders: true };
    expect((await h.run('vault_delete', { path: 'a.md' }, opts)).text).toContain('declined the deletion');
    expect((await h.run('vault_delete', { path: 'nope.md' }, opts)).text).toContain('there is no file "nope.md"');
    expect((await h.run('vault_delete', { path: 'chats/c.md' }, opts)).text).toContain('belongs to the app');
    expect(h.deleted).toEqual([]);
  });
});

describe('tasks_list (through the vault tools)', () => {
  it('reads the task index and degrades without the Tasks plugin', async () => {
    const TASK = { path: 'a.md', vaultId: 'vtest', line: 3, text: 'Tidy up', done: false } as SdkTaskRecord;
    const queries: unknown[] = [];
    const h = harness({}, {
      getTaskProvider: () => ({
        query: async (opts: unknown) => {
          queries.push(opts);
          return [TASK];
        },
        setDone: async () => {},
      }) as never,
    });
    expect((await h.run('tasks_list', { text: 'Tidy', vault: 'vtest' })).text).toBe(JSON.stringify(TASK));
    expect(queries[0]).toMatchObject({ text: 'Tidy', vaultId: 'vtest', sort: 'importance' });
    expect((await harness().run('tasks_list', {})).text).toContain('Tasks plugin is switched off');
  });
});

/** The editor's open tabs, as the tools reach them: buffers by `vaultId:path`, and what was done to them. */
function openTabs(buffers: Record<string, { content: string; dirty: boolean }>) {
  const applied: Array<{ key: string; content: string; save: boolean; origin: string }> = [];
  const moved: string[] = [];
  const closed: string[] = [];
  let takes = true;
  const openDocs: OpenDocs = {
    peek: async (vaultId, path) => buffers[`${vaultId}:${path}`] ?? null,
    dirty: async () =>
      Object.entries(buffers)
        .filter(([, doc]) => doc.dirty)
        .map(([key, doc]) => {
          const [vaultId, path] = key.split(':');
          return { vaultId, path, content: doc.content };
        }),
    apply: async (vaultId, path, content, options) => {
      if (!takes) {
        return { applied: false, saved: false };
      }
      applied.push({ key: `${vaultId}:${path}`, content, ...options });
      buffers[`${vaultId}:${path}`] = { content, dirty: !options.save };
      return { applied: true, saved: options.save };
    },
    moved: async (vaultId, from, to) => {
      moved.push(`${vaultId}:${from}>${to}`);
    },
    closed: async (vaultId, path) => {
      closed.push(`${vaultId}:${path}`);
    },
  };
  return {
    openDocs,
    applied,
    moved,
    closed,
    refuse: () => {
      takes = false;
    },
  };
}

describe('VaultTools — a file that is open in the editor (milestone 78)', () => {
  const ON_DISK = '# Plan\n\nFee: 10\n';
  const IN_TAB = '# Plan\n\nFee: 10\nUnsaved line\n';
  const AUTO: VaultCallOptions = { scope: ['vtest'], write: 'auto', origin: 'assistant' };

  it('reads and searches what the tab shows, unsaved text included', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: IN_TAB, dirty: true } });
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    expect((await h.run('vault_read', { path: 'plan.md' })).text).toContain('4: Unsaved line');
    const found = await h.run('vault_search', { query: 'unsaved' });
    expect(found.text).toContain('plan.md');
    expect(found.text).toContain('4: Unsaved line');
  });

  it('edits the buffer and saves from the tab instead of writing the file', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: IN_TAB, dirty: true } });
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    const result = await h.run(
      'vault_edit',
      { path: 'plan.md', edits: [{ old_text: 'Unsaved line', new_text: 'Kept line' }] },
      AUTO,
    );

    expect(result).toEqual({ text: 'Edited plan.md: 1 replacement at line 4.', isError: false });
    expect(tabs.applied).toEqual([
      { key: 'vtest:plan.md', content: '# Plan\n\nFee: 10\nKept line\n', save: true, origin: 'assistant' },
    ]);
    // The tab's own save wrote it: no second write, no announcement from the tool.
    expect(h.writes).toEqual([]);
    expect(h.announced).toEqual([]);
  });

  it('shows the confirmation the buffer, not the stale file', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: IN_TAB, dirty: true } });
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    await h.run(
      'vault_edit',
      { path: 'plan.md', edits: [{ old_text: 'Fee: 10', new_text: 'Fee: 12' }] },
      { scope: ['vtest'], write: 'confirm' },
    );

    expect(h.confirms[0]).toMatchObject({ before: IN_TAB, after: '# Plan\n\nFee: 12\nUnsaved line\n' });
  });

  it('says so when the tab took the change but could not save it', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: ON_DISK, dirty: false } });
    tabs.openDocs.apply = async () => ({ applied: true, saved: false });
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    const result = await h.run(
      'vault_write',
      { path: 'plan.md', content: 'More\n', mode: 'append' },
      AUTO,
    );

    expect(result.text).toBe(
      'Appended to plan.md (now 5 lines). The change is in the open editor tab and not saved yet.',
    );
  });

  it('changes nothing when the tab does not take the change', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: ON_DISK, dirty: false } });
    tabs.refuse();
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    const result = await h.run(
      'vault_edit',
      { path: 'plan.md', edits: [{ old_text: 'Fee: 10', new_text: 'Fee: 12' }] },
      AUTO,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('could not be applied there');
    expect(h.writes).toEqual([]);
  });

  it('writes a file that is not open to disk, as before', async () => {
    const tabs = openTabs({});
    const h = harness({ vtest: { 'plan.md': ON_DISK } }, { openDocs: tabs.openDocs });

    await h.run('vault_edit', { path: 'plan.md', edits: [{ old_text: 'Fee: 10', new_text: 'Fee: 12' }] }, AUTO);

    expect(tabs.applied).toEqual([]);
    expect(h.writes).toMatchObject([{ path: 'plan.md', content: '# Plan\n\nFee: 12\n' }]);
    expect(h.announced).toHaveLength(1);
  });

  it('a moved file takes its tab along, a deleted one closes it', async () => {
    const tabs = openTabs({ 'vtest:other.md': { content: 'See [[plan]].\n', dirty: true } });
    const h = harness(
      { vtest: { 'plan.md': ON_DISK, 'other.md': 'See [[plan]].\n', 'old.md': 'x\n' } },
      { openDocs: tabs.openDocs },
    );

    await h.run('vault_move', { from: 'plan.md', to: 'archive/plan.md' }, AUTO);
    await h.run('vault_delete', { path: 'old.md' }, AUTO);

    expect(tabs.moved).toEqual(['vtest:plan.md>archive/plan.md']);
    // Unsaved notes are handed to the link rewrite as buffers (ADR-0059).
    expect(h.renames[0].buffers).toEqual([{ path: 'other.md', content: 'See [[plan]].\n' }]);
    expect(tabs.closed).toEqual(['vtest:old.md']);
  });

  it('tells the caller about every change it made', async () => {
    const changes: unknown[] = [];
    const h = harness({ vtest: { 'plan.md': ON_DISK } });

    await h.run(
      'vault_edit',
      { path: 'plan.md', edits: [{ old_text: 'Fee: 10', new_text: 'Fee: 12' }] },
      { ...AUTO, onChange: (change) => changes.push(change) },
    );

    expect(changes).toEqual([
      { vaultId: 'vtest', path: 'plan.md', before: ON_DISK, after: '# Plan\n\nFee: 12\n' },
    ]);
  });
});

describe('VaultTools — files a call carries in its own scope (milestone 78)', () => {
  const NOTE = '# Plan\n\nFee: 10\n';
  const files = () => ({ vtest: { 'plan.md': NOTE, 'other.md': 'Other\n' }, docs: { 'guide.md': 'Guide\n' } });
  const EDIT = { path: 'plan.md', edits: [{ old_text: 'Fee: 10', new_text: 'Fee: 12' }] };
  const names = (h: ReturnType<typeof harness>, options: VaultCallOptions): string[] =>
    h.tools.toolSpecs(options).map((spec) => spec.name);

  it('offers only the single-file tools when no vault is in scope', () => {
    const h = harness(files());
    const own = [{ vaultId: 'vtest', path: 'plan.md' }];

    expect(names(h, { scope: [], write: 'confirm', files: own })).toEqual([
      'vault_read',
      'vault_edit',
      'vault_write',
    ]);
    expect(names(h, { scope: [], write: 'off', files: own })).toEqual([
      'vault_read',
      'vault_edit',
      'vault_write',
    ]);
  });

  it('adds the tools to change the file where the vault may only be read', () => {
    const h = harness(files());

    expect(
      names(h, { scope: ['docs'], write: 'off', files: [{ vaultId: 'vtest', path: 'plan.md' }] }),
    ).toEqual(['vault_list', 'vault_search', 'vault_read', 'vault_edit', 'vault_write']);
  });

  it('reaches the file by its path alone, and nothing else in its vault', async () => {
    const h = harness(files());
    const options: VaultCallOptions = {
      scope: [],
      write: 'auto',
      files: [{ vaultId: 'vtest', path: 'plan.md' }],
    };

    expect((await h.run('vault_read', { path: 'plan.md' }, options)).text).toContain('3: Fee: 10');
    const other = await h.run('vault_read', { path: 'other.md' }, options);
    expect(other.isError).toBe(true);
    expect(other.text).toContain('only plan.md can be read and changed in this conversation');
    expect((await h.run('vault_search', { query: 'fee' }, options)).isError).toBe(true);
  });

  it('finds the file in its own vault while the scope names another one', async () => {
    const h = harness(files());
    const options: VaultCallOptions = {
      scope: ['docs'],
      write: 'auto',
      files: [{ vaultId: 'vtest', path: 'plan.md' }],
    };

    expect((await h.run('vault_edit', EDIT, options)).isError).toBe(false);
    expect(h.store['vtest']['plan.md']).toContain('Fee: 12');
    // The scope still bounds everything else.
    expect((await h.run('vault_read', { path: 'other.md', vault: 'vtest' }, options)).isError).toBe(true);
  });

  it('asks first where the write rule is off, and still refuses every other file', async () => {
    const h = harness(files());
    const options: VaultCallOptions = {
      scope: ['vtest'],
      write: 'off',
      files: [{ vaultId: 'vtest', path: 'plan.md' }],
    };

    expect((await h.run('vault_edit', EDIT, options)).isError).toBe(false);
    expect(h.confirms).toHaveLength(1);
    const other = await h.run(
      'vault_edit',
      { path: 'other.md', edits: [{ old_text: 'Other', new_text: 'X' }] },
      options,
    );
    expect(other.text).toContain('changing files is switched off');
    expect((await h.run('vault_delete', { path: 'plan.md' }, options)).text).toContain(
      'changing files is switched off',
    );
  });

  it('a live file is changed in its tab at once: no dialog, not saved', async () => {
    const tabs = openTabs({ 'vtest:plan.md': { content: NOTE, dirty: false } });
    const h = harness(files(), { openDocs: tabs.openDocs });

    const result = await h.run('vault_edit', EDIT, {
      scope: [],
      write: 'confirm',
      origin: 'assistant',
      files: [{ vaultId: 'vtest', path: 'plan.md', live: true }],
    });

    expect(result).toEqual({ text: 'Edited plan.md: 1 replacement at line 3.', isError: false });
    expect(h.confirms).toEqual([]);
    expect(tabs.applied).toEqual([
      { key: 'vtest:plan.md', content: '# Plan\n\nFee: 12\n', save: false, origin: 'assistant' },
    ]);
    expect(h.writes).toEqual([]);
  });

  it('a tab that was never saved is read and changed in the editor only', async () => {
    const tabs = openTabs({ ':Untitled-1': { content: 'Draft text\n', dirty: true } });
    const h = harness({ vtest: { 'Untitled-1': 'A FILE OF THE SAME NAME\n' } }, { openDocs: tabs.openDocs });
    const options: VaultCallOptions = {
      scope: ['vtest'],
      write: 'auto',
      origin: 'assistant',
      files: [{ vaultId: '', path: 'Untitled-1' }],
    };

    expect((await h.run('vault_read', { path: 'Untitled-1' }, options)).text).toContain('1: Draft text');
    const result = await h.run(
      'vault_edit',
      { path: 'Untitled-1', edits: [{ old_text: 'Draft', new_text: 'Final' }] },
      options,
    );

    expect(result.isError).toBe(false);
    // Into the tab, never saved by the tool, and the vault's file untouched.
    expect(tabs.applied).toEqual([
      { key: ':Untitled-1', content: 'Final text\n', save: false, origin: 'assistant' },
    ]);
    expect(h.writes).toEqual([]);
    expect(h.store['vtest']['Untitled-1']).toBe('A FILE OF THE SAME NAME\n');
  });

  it('a tab that was closed meanwhile is not looked up on disk', async () => {
    const tabs = openTabs({});
    const h = harness({ vtest: { 'Untitled-1': 'A FILE OF THE SAME NAME\n' } }, { openDocs: tabs.openDocs });
    const options: VaultCallOptions = {
      scope: [],
      write: 'auto',
      files: [{ vaultId: '', path: 'Untitled-1', live: true }],
    };

    expect((await h.run('vault_read', { path: 'Untitled-1' }, options)).isError).toBe(true);
    const written = await h.run(
      'vault_write',
      { path: 'Untitled-1', content: 'x', mode: 'overwrite' },
      options,
    );
    expect(written.text).toContain('is not open in the editor any more');
    expect(h.writes).toEqual([]);
  });
});
