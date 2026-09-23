// @vitest-environment jsdom
import { TemplateLibrary } from './library';

/**
 * The templates plugin's library logic (ADR-0044 stage 3): category tree
 * building, recents tracking and the insert gate — the pure parts ported
 * from the old Angular service, driven through a fake plugin API.
 */

function fakeApi(files: Record<string, string>, tree: unknown[]): {
  api: TemplateLibrary['api'];
  inserted: string[];
} {
  const inserted: string[] = [];
  const api = {
    appConfig: {
      get: async () => ({ templates: { dir: 'templates' } }),
      patch: async () => undefined,
    },
    vault: {
      listFiles: async () => tree,
      readFile: async (path: string) => {
        if (!(path in files)) {
          throw new Error(`not found: ${path}`);
        }
        return { content: files[path], modifiedMs: 1 };
      },
    },
    documents: {
      active: () => ({ path: 'notes/today.md', kind: 'text' }),
      insertAtCursor: (text: string) => {
        inserted.push(text);
        return true;
      },
    },
  } as unknown as TemplateLibrary['api'];
  return { api, inserted };
}

const TREE = [
  {
    name: 'templates',
    relativePath: 'templates',
    type: 'directory',
    children: [
      { name: 'todo.md', relativePath: 'templates/todo.md', type: 'file' },
      {
        name: 'meetings',
        relativePath: 'templates/meetings',
        type: 'directory',
        children: [
          { name: '1-1.md', relativePath: 'templates/meetings/1-1.md', type: 'file' },
        ],
      },
    ],
  },
];

describe('templates plugin library', () => {
  it('builds the category tree with a synthetic General group', async () => {
    const { api } = fakeApi({}, TREE);
    const library = new TemplateLibrary(api);
    await library.reload();
    expect(library.categories.map((c) => c.name)).toEqual(['General', 'meetings']);
    expect(library.categories[0].templates.map((t) => t.name)).toEqual(['todo']);
    expect(library.all.map((t) => t.relativePath)).toEqual([
      'templates/todo.md',
      'templates/meetings/1-1.md',
    ]);
  });

  it('inserts with frontmatter stripped and placeholders substituted', async () => {
    const { api, inserted } = fakeApi(
      {
        'templates/todo.md': '---\ntitle: internal\n---\n# {{title}}\n\n{{date}} {{time}}',
      },
      TREE,
    );
    const library = new TemplateLibrary(api);
    await library.reload();
    const result = await library.insert('templates/todo.md');
    expect(result.ok).toBe(true);
    expect(inserted[0]).not.toContain('title: internal');
    // The tab name without the .md extension is the title.
    expect(inserted[0]).toContain('# today');
    expect(inserted[0]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('refuses to insert with no active text document', async () => {
    const { api, inserted } = fakeApi({ 'templates/todo.md': 'x' }, TREE);
    const library = new TemplateLibrary(api);
    await library.reload();
    (library.api.documents as { active: () => null }).active = () => null;
    const result = await library.insert('templates/todo.md');
    expect(result.ok).toBe(false);
    expect(inserted).toEqual([]);
  });

  it('tracks recents, most-recent first, capped, surviving reloads', async () => {
    localStorage.removeItem('drey.templates.recent');
    const { api } = fakeApi(
      {
        'templates/todo.md': '# todo',
        'templates/meetings/1-1.md': '# 1-1',
      },
      TREE,
    );
    const library = new TemplateLibrary(api);
    await library.reload();
    await library.insert('templates/todo.md');
    await library.insert('templates/meetings/1-1.md');
    expect(library.recent.map((t) => t.name)).toEqual(['1-1', 'todo']);
    const fresh = new TemplateLibrary(api);
    await fresh.reload();
    expect(fresh.recent.map((t) => t.name)).toEqual(['1-1', 'todo']);
    localStorage.removeItem('drey.templates.recent');
  });
});
