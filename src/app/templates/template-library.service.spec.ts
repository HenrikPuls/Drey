import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault';
import { TemplateLibraryService } from './template-library.service';

function dir(name: string, relativePath: string, children: VaultFileEntry[]): VaultFileEntry {
  return { name, relativePath, type: 'directory', children };
}
function file(name: string, relativePath: string): VaultFileEntry {
  return { name, relativePath, type: 'file' };
}

/** templates/ with a loose file, a category, and a nested sub-category. */
const TREE: VaultFileEntry[] = [
  dir('templates', 'templates', [
    file('daily.md', 'templates/daily.md'),
    file('readme.txt', 'templates/readme.txt'),
    dir('meetings', 'templates/meetings', [
      file('1-1.md', 'templates/meetings/1-1.md'),
      file('standup.md', 'templates/meetings/standup.md'),
      dir('external', 'templates/meetings/external', [
        file('kickoff.md', 'templates/meetings/external/kickoff.md'),
      ]),
    ]),
  ]),
  dir('notes', 'notes', [file('real.md', 'notes/real.md')]),
];

const CONTENT: Record<string, string> = {
  'templates/daily.md': '---\ntitle: "{{title}}"\n---\n\n# {{date}}\n\n## {{time}}\n',
  'templates/meetings/1-1.md': '## 1:1 — {{date}}\n- \n',
};

describe('TemplateLibraryService', () => {
  let lib: TemplateLibraryService;
  let fileTree: ReturnType<typeof signal<VaultFileEntry[]>>;
  let templatesDir: ReturnType<typeof signal<string>>;
  let activePath: ReturnType<typeof signal<string | null>>;
  let inserted: string[];
  let errors: (string | null)[];

  beforeEach(() => {
    localStorage.clear();
    fileTree = signal<VaultFileEntry[]>(TREE);
    templatesDir = signal('templates');
    activePath = signal<string | null>('notes/real.md');
    inserted = [];
    errors = [];

    TestBed.configureTestingModule({
      providers: [
        TemplateLibraryService,
        { provide: VaultService, useValue: { fileTree, readTextFile: (p: string) => Promise.resolve(CONTENT[p] ?? '') } },
        { provide: SettingsService, useValue: { templatesDir } },
        {
          provide: EditorService,
          useValue: {
            activePath,
            activeKind: () => 'text',
            requestInsertText: (t: string) => inserted.push(t),
            error: { set: (m: string | null) => errors.push(m) },
          },
        },
      ],
    });
    lib = TestBed.inject(TemplateLibraryService);
  });

  it('builds a category tree: loose .md under "General", sub-folders recurse, .md only', () => {
    const cats = lib.categories();
    expect(cats.map((c) => c.name)).toEqual(['General', 'meetings']);

    const general = cats[0];
    expect(general.templates.map((t) => t.name)).toEqual(['daily']); // readme.txt excluded
    expect(general.path).toBe('templates');

    const meetings = cats[1];
    expect(meetings.templates.map((t) => t.name)).toEqual(['1-1', 'standup']); // sorted, no ext
    expect(meetings.children.map((c) => c.name)).toEqual(['external']);
    expect(meetings.children[0].templates.map((t) => t.relativePath)).toEqual([
      'templates/meetings/external/kickoff.md',
    ]);
  });

  it('returns no categories when the configured folder is missing', () => {
    templatesDir.set('does/not/exist');
    expect(lib.categories()).toEqual([]);
    expect(lib.all()).toEqual([]);
  });

  it('follows a nested configured folder', () => {
    templatesDir.set('templates/meetings');
    expect(lib.categories().map((c) => c.name)).toEqual(['General', 'external']);
  });

  it('insert() strips frontmatter, substitutes placeholders, inserts, records recent', async () => {
    await lib.insert('templates/daily.md');
    expect(inserted).toHaveLength(1);
    const text = inserted[0];
    expect(text.startsWith('---')).toBe(false); // frontmatter gone
    expect(text).toContain(new Date().getFullYear().toString()); // {{date}} filled
    expect(text).not.toContain('{{date}}');
    expect(text).not.toContain('{{time}}');

    expect(lib.recent().map((t) => t.relativePath)).toEqual(['templates/daily.md']);
  });

  it('recent() is most-recent-first, de-duplicated, capped at 5, and drops unknown paths', async () => {
    for (const p of [
      'templates/daily.md',
      'templates/meetings/1-1.md',
      'templates/meetings/standup.md',
      'templates/meetings/external/kickoff.md',
      'templates/daily.md', // repeat -> moves to front, no dupe
    ]) {
      await lib.insert(p);
    }
    expect(lib.recent().map((t) => t.name)).toEqual(['daily', 'kickoff', 'standup', '1-1']);

    // A path no longer in the tree is silently dropped from the view.
    localStorage.setItem(
      'drey.templates.recent',
      JSON.stringify(['templates/gone.md', 'templates/daily.md']),
    );
    TestBed.resetTestingModule();
    // rebuild with the same providers
    TestBed.configureTestingModule({
      providers: [
        TemplateLibraryService,
        { provide: VaultService, useValue: { fileTree, readTextFile: () => Promise.resolve('') } },
        { provide: SettingsService, useValue: { templatesDir } },
        {
          provide: EditorService,
          useValue: {
            activePath,
            activeKind: () => 'text',
            requestInsertText: () => {},
            error: { set: () => {} },
          },
        },
      ],
    });
    const fresh = TestBed.inject(TemplateLibraryService);
    expect(fresh.recent().map((t) => t.relativePath)).toEqual(['templates/daily.md']);
  });

  it('insert() with no open note surfaces an error and does not insert', async () => {
    activePath.set(null);
    await lib.insert('templates/daily.md');
    expect(inserted).toHaveLength(0);
    expect(errors.at(-1)).toContain('Open a note');
  });

  it('survives a throwing localStorage', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          TemplateLibraryService,
          { provide: VaultService, useValue: { fileTree, readTextFile: () => Promise.resolve('') } },
          { provide: SettingsService, useValue: { templatesDir } },
          {
            provide: EditorService,
            useValue: {
              activePath,
              activeKind: () => 'text',
              requestInsertText: () => {},
              error: { set: () => {} },
            },
          },
        ],
      });
      expect(() => TestBed.inject(TemplateLibraryService).recent()).not.toThrow();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
