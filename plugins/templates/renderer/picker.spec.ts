// @vitest-environment jsdom
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { TemplateCategory, TemplateEntry, TemplateLibrary } from './library';
import {
  COLLAPSE_ABOVE,
  countTemplates,
  folderOf,
  folderPaths,
  mountTemplatePicker,
  pickerRows,
  type PickerRow,
} from './picker';

/**
 * The template picker (req-41): the row model -- recents, folder tree,
 * flat filter matches -- and the mounted list's keyboard handling.
 */

const entry = (relativePath: string): TemplateEntry => ({
  name: (relativePath.split('/').pop() ?? '').replace(/\.md$/, ''),
  relativePath,
});

const TREE: TemplateCategory[] = [
  { name: 'General', path: 'templates', templates: [entry('templates/daily.md')], children: [] },
  {
    name: 'meetings',
    path: 'templates/meetings',
    templates: [entry('templates/meetings/1-1.md')],
    children: [
      {
        name: 'weekly',
        path: 'templates/meetings/weekly',
        templates: [entry('templates/meetings/weekly/review.md')],
        children: [],
      },
    ],
  },
];

const shape = (rows: readonly PickerRow[]): string[] =>
  rows.map((row) =>
    row.kind === 'label'
      ? `# ${row.text}`
      : row.kind === 'folder'
        ? `${'  '.repeat(row.depth)}${row.open ? 'v' : '>'} ${row.name} (${row.count})`
        : `${'  '.repeat(row.depth)}${row.entry.name}${row.detail === '' ? '' : ` [${row.detail}]`}`,
  );

describe('template picker rows', () => {
  it('shows root files first, then folders with their rows while open', () => {
    expect(shape(pickerRows(TREE, [], '', new Set(), 'templates'))).toEqual([
      'daily',
      'v meetings (2)',
      '  1-1',
      '  v weekly (1)',
      '    review',
    ]);
  });

  it('hides the rows of a collapsed folder, subfolders included', () => {
    expect(
      shape(pickerRows(TREE, [], '', new Set(['templates/meetings']), 'templates')),
    ).toEqual(['daily', '> meetings (2)']);
  });

  it('leads with the recents, each carrying its folder', () => {
    const recent = [entry('templates/meetings/weekly/review.md')];
    expect(
      shape(pickerRows(TREE, recent, '', new Set(['templates/meetings']), 'templates')),
    ).toEqual(['# Recent', 'review [meetings/weekly]', '# All templates', 'daily', '> meetings (2)']);
  });

  it('a filter flattens the tree to the matches by name or path, ignoring collapse', () => {
    const collapsed = new Set(['templates/meetings']);
    expect(shape(pickerRows(TREE, [], 'REV', collapsed, 'templates'))).toEqual([
      'review [meetings/weekly]',
    ]);
    expect(shape(pickerRows(TREE, [], 'weekly', collapsed, 'templates'))).toEqual([
      'review [meetings/weekly]',
    ]);
    expect(pickerRows(TREE, [], 'nope', collapsed, 'templates')).toEqual([]);
  });

  it('counts and lists folders through every level', () => {
    expect(countTemplates(TREE[1])).toBe(2);
    expect(folderPaths(TREE, 'templates')).toEqual([
      'templates/meetings',
      'templates/meetings/weekly',
    ]);
    expect(folderOf(entry('templates/daily.md'), 'templates')).toBe('');
  });
});

describe('mounted template picker', () => {
  const api = {
    ui: { icon: () => document.createElement('span') },
  } as unknown as DreyPluginApi;

  function fakeLibrary(categories: TemplateCategory[]): TemplateLibrary {
    return {
      dir: 'templates',
      noteCategories: categories,
      recent: [],
      render: (path: string) => Promise.resolve(`body of ${path}`),
      onChange: () => () => undefined,
    } as unknown as TemplateLibrary;
  }

  function mount(categories: TemplateCategory[] = TREE) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const picked: string[] = [];
    let closed = 0;
    const dispose = mountTemplatePicker(
      api,
      fakeLibrary(categories),
      host,
      (e) => picked.push(e.relativePath),
      () => (closed += 1),
    );
    const key = (name: string): void => {
      host.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    };
    const active = (): string =>
      host.querySelector('.tpl-pick-row.active .tpl-pick-name')?.textContent ?? '';
    const names = (): string[] =>
      [...host.querySelectorAll('.tpl-pick-row .tpl-pick-name')].map((n) => n.textContent ?? '');
    return { host, key, active, names, picked, closed: () => closed, dispose };
  }

  afterEach(() => {
    document.body.textContent = '';
  });

  it('starts on the first row and previews it', async () => {
    const p = mount();
    expect(p.active()).toBe('daily');
    expect(p.host.querySelector('.tpl-pick-head')?.textContent).toBe('templates/daily.md');
    await Promise.resolve();
    await Promise.resolve();
    expect(p.host.querySelector('.tpl-pick-body')?.textContent).toBe('body of templates/daily.md');
    p.dispose();
  });

  it('the arrow keys walk the rows, Enter inserts the template and closes', () => {
    const p = mount();
    p.key('ArrowDown');
    expect(p.active()).toBe('meetings');
    p.key('ArrowDown');
    expect(p.active()).toBe('1-1');
    p.key('ArrowUp');
    p.key('ArrowUp');
    p.key('ArrowUp'); // stays on the first row
    expect(p.active()).toBe('daily');
    p.key('PageDown');
    expect(p.active()).toBe('review');
    p.key('Enter');
    expect(p.picked).toEqual(['templates/meetings/weekly/review.md']);
    expect(p.closed()).toBe(1);
    p.dispose();
  });

  it('Enter and the arrows open and close a folder, keeping the keys on it', () => {
    const p = mount();
    p.key('ArrowDown'); // meetings (open)
    p.key('ArrowLeft');
    expect(p.names()).toEqual(['daily', 'meetings']);
    expect(p.active()).toBe('meetings');
    expect(p.host.querySelector('.tpl-pick-body')?.textContent).toBe('2 templates');
    p.key('ArrowRight');
    expect(p.names()).toEqual(['daily', 'meetings', '1-1', 'weekly', 'review']);
    expect(p.active()).toBe('meetings');
    p.key('Enter');
    expect(p.names()).toEqual(['daily', 'meetings']);
    expect(p.picked).toEqual([]);
    p.dispose();
  });

  it('typing filters to a flat list; Escape closes without a pick', () => {
    const p = mount();
    const input = p.host.querySelector('.tpl-pick-input') as HTMLInputElement;
    input.value = 'rev';
    input.dispatchEvent(new Event('input'));
    expect(p.names()).toEqual(['review']);
    expect(p.active()).toBe('review');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(p.host.querySelector('.tpl-pick-empty')?.textContent).toBe('No matching template');
    p.key('Escape');
    expect(p.closed()).toBe(1);
    expect(p.picked).toEqual([]);
    p.dispose();
  });

  it('a large library starts with its folders collapsed', () => {
    const many: TemplateCategory[] = [
      {
        name: 'bulk',
        path: 'templates/bulk',
        templates: Array.from({ length: COLLAPSE_ABOVE + 1 }, (_, i) => entry(`templates/bulk/t${i}.md`)),
        children: [],
      },
    ];
    const p = mount(many);
    expect(p.names()).toEqual(['bulk']);
    p.dispose();
  });
});
