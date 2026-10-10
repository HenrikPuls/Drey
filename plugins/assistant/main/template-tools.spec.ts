import { describe, expect, it } from 'vitest';
import {
  createTemplateTools,
  normalizeTemplateDir,
  resolveTemplate,
  templatePathsInDir,
  type ResolvedTemplate,
  type TemplateToolsPort,
} from './template-tools';

/**
 * The template_* tools: the pure path/guard rules (escapes, the reserved
 * `prompts/` folder, the `.md` suffix) and each tool's contract against a
 * fake vault port — create/replace semantics, the `daily.md` delete
 * refusal, and the never-throw error-as-text rule.
 */

const DIR = 'templates';

function pathOf(result: ResolvedTemplate): string {
  return 'path' in result ? result.path : `unexpected refusal: ${result.refused}`;
}

function refusalOf(result: ResolvedTemplate): string {
  return 'refused' in result ? result.refused : `unexpected path: ${result.path}`;
}

function makePort(files: string[], overrides?: Partial<TemplateToolsPort>): TemplateToolsPort & {
  written: Array<{ path: string; content: string }>;
  removed: string[];
} {
  const self: TemplateToolsPort & {
    written: Array<{ path: string; content: string }>;
    removed: string[];
  } = {
    written: [],
    removed: [],
    templatesDir: () => DIR,
    listMarkdownFiles: async () => files,
    read: async (path) =>
      files.includes(path) ? `content of ${path}` : Promise.reject(new Error('ENOENT')),
    writeAnnounced: async (path, content) => {
      self.written.push({ path, content });
    },
    remove: async (path) => {
      self.removed.push(path);
      return true;
    },
    ...overrides,
  };
  return self;
}

describe('resolveTemplate', () => {
  it('resolves under the configured dir and appends .md', () => {
    expect(pathOf(resolveTemplate('templates', 'meeting-notes'))).toBe(
      'templates/meeting-notes.md',
    );
    expect(pathOf(resolveTemplate('templates', 'meetings/retro.md'))).toBe(
      'templates/meetings/retro.md',
    );
  });

  it('normalizes separators and leading slashes', () => {
    expect(pathOf(resolveTemplate('templates', '\\meetings\\retro'))).toBe(
      'templates/meetings/retro.md',
    );
    expect(pathOf(resolveTemplate('templates', '/retro/'))).toBe('templates/retro.md');
    expect(pathOf(resolveTemplate('templates', './retro'))).toBe('templates/retro.md');
  });

  it('refuses escapes, absolute names and empties', () => {
    expect(refusalOf(resolveTemplate('templates', '../note'))).toMatch(/escapes/);
    expect(refusalOf(resolveTemplate('templates', 'a/../..//b'))).toMatch(/escapes/);
    expect(refusalOf(resolveTemplate('templates', 'C:/vault/note'))).toMatch(/not a name/);
    expect(refusalOf(resolveTemplate('templates', '  '))).toMatch(/empty/);
    expect(refusalOf(resolveTemplate('templates', '.'))).toMatch(/empty/);
  });

  it('refuses the reserved prompts folder (case-insensitive, top-level only)', () => {
    expect(refusalOf(resolveTemplate('templates', 'prompts/daily-warmup'))).toMatch(/reserved/);
    expect(refusalOf(resolveTemplate('templates', 'Prompts/x'))).toMatch(/reserved/);
    expect(pathOf(resolveTemplate('templates', 'meetings/prompts/x'))).toBe(
      'templates/meetings/prompts/x.md',
    );
  });

  it('normalizes the configured dir itself', () => {
    expect(normalizeTemplateDir('\\vorlagen\\')).toBe('vorlagen');
    expect(normalizeTemplateDir('')).toBe('templates');
    expect(normalizeTemplateDir(undefined)).toBe('templates');
  });

  it('filters and sorts a flat listing to the folder', () => {
    expect(
      templatePathsInDir('templates', [
        'notes/a.md',
        'templates/b.md',
        'templates/sub/a.md',
        'templates/readme.txt',
        'templates/.hidden.md',
      ]),
    ).toEqual(['templates/.hidden.md', 'templates/b.md', 'templates/sub/a.md']);
  });
});

describe('template tools', () => {
  it('template_list returns one path per line, or an empty-library note', async () => {
    const port = makePort(['notes/a.md', 'templates/b.md', 'templates/sub/a.md']);
    const tools = createTemplateTools(port);
    expect(await tools.run('template_list', '{}')).toBe('templates/b.md\ntemplates/sub/a.md');

    const empty = createTemplateTools(makePort(['notes/a.md']));
    expect(await empty.run('template_list', '{}')).toMatch(/empty/);
  });

  it('template_read returns the body and a clear miss', async () => {
    const port = makePort(['templates/retro.md']);
    const tools = createTemplateTools(port);
    expect(await tools.run('template_read', '{"name":"retro"}')).toBe(
      'content of templates/retro.md',
    );
    expect(await tools.run('template_read', '{"name":"missing"}')).toMatch(
      /No template at templates\/missing\.md/,
    );
  });

  it('template_write creates, refuses silent overwrite, replaces on flag', async () => {
    const port = makePort(['templates/retro.md']);
    const tools = createTemplateTools(port);

    expect(await tools.run('template_write', '{"name":"retro","content":"x"}')).toMatch(
      /already exists/,
    );
    expect(port.written).toEqual([]);

    expect(await tools.run('template_write', '{"name":"new","content":"body"}')).toMatch(
      /Created the template templates\/new\.md/,
    );
    expect(port.written).toEqual([{ path: 'templates/new.md', content: 'body' }]);

    expect(
      await tools.run('template_write', '{"name":"retro","content":"v2","overwrite":true}'),
    ).toMatch(/Replaced the template templates\/retro\.md/);
    expect(port.written[1]).toEqual({ path: 'templates/retro.md', content: 'v2' });
  });

  it('template_write refuses empty content and malformed args without throwing', async () => {
    const port = makePort([]);
    const tools = createTemplateTools(port);
    expect(await tools.run('template_write', '{"name":"x","content":"   "}')).toMatch(
      /non-empty/,
    );
    expect(await tools.run('template_write', 'not json')).toMatch(/^Error: Could not parse/);
    expect(await tools.run('nope', '{}')).toMatch(/^Unknown tool/);
  });

  it('template_delete refuses daily.md, deletes to the bin, reports permanence', async () => {
    const port = makePort(['templates/daily.md', 'templates/old.md']);
    const tools = createTemplateTools(port);

    expect(await tools.run('template_delete', '{"name":"daily"}')).toMatch(/Refusing to delete/);
    expect(port.removed).toEqual([]);

    expect(await tools.run('template_delete', '{"name":"old"}')).toMatch(
      /moved to the recycle bin/,
    );
    expect(port.removed).toEqual(['templates/old.md']);

    const binless = createTemplateTools(
      makePort(['templates/old.md'], { remove: async () => false }),
    );
    expect(await binless.run('template_delete', '{"name":"old"}')).toMatch(/removed permanently/);
  });

  it('port failures come back as error text, not rejections', async () => {
    const port = makePort(['templates/old.md'], {
      remove: async () => {
        throw new Error('EPERM');
      },
    });
    const tools = createTemplateTools(port);
    expect(await tools.run('template_delete', '{"name":"old"}')).toMatch(/^Error: EPERM/);
  });
});
