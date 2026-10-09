import { resolveTaskLine, scanTasks, setDoneOnLine } from '../../../plugins/tasks/shared/tasks';

/** A single quote, for building quoted YAML scalars in expectations. */
const QUOTE = String.fromCharCode(39);

/**
 * The Tasks plugin's pure scanner (`plugins/tasks/shared/tasks`), relocated
 * from `src/app/tasks/` at the ADR-0044 stage-6 conversion: the ng test
 * runner ignores `plugins/**`, so the spec lives here and imports the
 * plugin source directly.
 */

describe('scanTasks', () => {
  it('finds checkbox tasks with their done-state and text', () => {
    const doc = '- [ ] buy milk\n- [x] call Anna\n  - [X] nested and done\n';
    expect(scanTasks('n.md', doc)).toEqual([
      {
        path: 'n.md',
        vaultId: '',
        line: 1,
        text: 'buy milk',
        done: false,
        kind: 'checkbox',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
      {
        path: 'n.md',
        vaultId: '',
        line: 2,
        text: 'call Anna',
        done: true,
        kind: 'checkbox',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
      {
        path: 'n.md',
        vaultId: '',
        line: 3,
        text: 'nested and done',
        done: true,
        kind: 'checkbox',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
    ]);
  });

  it('finds #task lines, done only when #task/done is present', () => {
    const doc = 'Fix the roof #task\nMow the lawn #task #task/done\n';
    const tasks = scanTasks('n.md', doc);
    expect(tasks).toEqual([
      {
        path: 'n.md',
        vaultId: '',
        line: 1,
        text: 'Fix the roof',
        done: false,
        kind: 'tag',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
      {
        path: 'n.md',
        vaultId: '',
        line: 2,
        text: 'Mow the lawn',
        done: true,
        kind: 'tag',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
    ]);
  });

  it('reports a checkbox+#task line once, as a checkbox', () => {
    const tasks = scanTasks('n.md', '- [ ] ship it #task\n');
    expect(tasks).toEqual([
      {
        path: 'n.md',
        vaultId: '',
        line: 1,
        text: 'ship it',
        done: false,
        kind: 'checkbox',
        heading: null,
        tags: [],
        due: null,
        priority: null,
      },
    ]);
  });

  it('parses Obsidian-Tasks metadata into due/priority, stripped from the text (req-37)', () => {
    const tasks = scanTasks('n.md', '- [ ] ship it 📅 2026-10-09 ⏫\n');
    expect(tasks[0].text).toBe('ship it');
    expect(tasks[0].due).toBe('2026-10-09');
    expect(tasks[0].priority).toBe('high');
  });

  it('keeps ordinary #tags in the text but drops #task markers', () => {
    const tasks = scanTasks('n.md', '- [ ] paint fence #home #outdoor #task\n');
    expect(tasks[0].text).toBe('paint fence #home #outdoor');
  });

  it('tracks the nearest heading above each task', () => {
    const doc = '# Top\n\n- [ ] a\n\n## Errands\n\n- [ ] b\nplain #task\n';
    expect(scanTasks('n.md', doc).map((t) => [t.text, t.heading])).toEqual([
      ['a', 'Top'],
      ['b', 'Errands'],
      ['plain', 'Errands'],
    ]);
  });

  it('ignores tasks inside fenced code blocks', () => {
    const doc = '- [ ] real\n```\n- [ ] fake\nalso fake #task\n```\n- [x] real done\n';
    expect(scanTasks('n.md', doc).map((t) => t.text)).toEqual(['real', 'real done']);
  });

  it('does not treat a timestamp heading as a #task', () => {
    expect(scanTasks('n.md', '## 14:32\ntext without markers\n')).toEqual([]);
  });

  it('stamps the records with the owning vault (milestone 34)', () => {
    expect(scanTasks('n.md', '- [ ] a\n', 'vault-2').map((t) => t.vaultId)).toEqual(['vault-2']);
  });

  describe('section tags', () => {
    it('attaches the containing section’s inline tags to a task', () => {
      const doc =
        '## Projekt Alpha #project #kunde\n\n- [ ] draft the brief\n- [x] send invoice #buchhaltung\n';
      const tasks = scanTasks('n.md', doc);
      expect(tasks[0].tags).toEqual(['project', 'kunde', 'buchhaltung']);
      expect(tasks[1].tags).toEqual(['project', 'kunde', 'buchhaltung']);
    });

    it('scopes tags to the section a task sits in', () => {
      const doc = '## A #alpha\n\n- [ ] one\n\n## B #beta\n\n- [ ] two\n';
      const tasks = scanTasks('n.md', doc);
      expect(tasks.map((t) => [t.text, t.tags])).toEqual([
        ['one', ['alpha']],
        ['two', ['beta']],
      ]);
    });

    it('captures a tag written directly on the task line', () => {
      const doc = '# Notes\n\n- [ ] call plumber #haus #dringend\n';
      expect(scanTasks('n.md', doc)[0].tags).toEqual(['haus', 'dringend']);
    });

    it('is empty for a task before the first heading with no tags around it', () => {
      expect(scanTasks('n.md', '- [ ] loose task\n\n# Later\n')[0].tags).toEqual([]);
    });

    it('does not treat the #task marker as a section tag', () => {
      expect(scanTasks('n.md', '## Roof #dach\n\nrepair gutter #task\n')[0].tags).toEqual(['dach']);
    });
  });
});

describe('setDoneOnLine', () => {
  it('flips a checkbox both ways and is a no-op when already in state', () => {
    const doc = '- [ ] a\n- [x] b\n';
    expect(setDoneOnLine(doc, 1, true)).toBe('- [x] a\n- [x] b\n');
    expect(setDoneOnLine(doc, 2, false)).toBe('- [ ] a\n- [ ] b\n');
    expect(setDoneOnLine(doc, 1, false)).toBe(doc);
  });

  it('adds and removes #task/done on a bare #task line', () => {
    expect(setDoneOnLine('water plants #task\n', 1, true)).toBe('water plants #task #task/done\n');
    expect(setDoneOnLine('water plants #task #task/done\n', 1, false)).toBe('water plants #task\n');
  });

  it('leaves a non-task line and an out-of-range line untouched', () => {
    expect(setDoneOnLine('just prose\n', 1, true)).toBe('just prose\n');
    expect(setDoneOnLine('- [ ] a\n', 9, true)).toBe('- [ ] a\n');
  });
});

describe('resolveTaskLine', () => {
  const doc = ['---', 'title: t', '---', '', '- [ ] draft', 'Fix the roof #task', ''].join('\n');

  it('keeps the exact line while a task still sits there', () => {
    const [row] = scanTasks('a.md', doc).filter((t) => t.text === 'draft');
    expect(resolveTaskLine(doc, row)).toBe(row.line);
  });

  it('follows the task after the frontmatter bump shifted every line', () => {
    // What the save pipeline produces on a first save: two inserted
    // frontmatter lines, so the panel's recorded line is 2 too small.
    const stamp = '2026-09-15T10:00:00';
    const grown = [
      '---',
      'title: t',
      'created: ' + QUOTE + stamp + QUOTE,
      'updated: ' + QUOTE + stamp + QUOTE,
      '---',
      '',
      '- [ ] draft',
      'Fix the roof #task',
      '',
    ].join('\n');
    const staleRow = {
      path: 'a.md',
      vaultId: '',
      line: 5,
      text: 'Fix the roof',
      done: false,
      kind: 'tag' as const,
      heading: 'Wohnen',
      tags: [],
      due: null,
      priority: null,
    };
    expect(resolveTaskLine(grown, staleRow)).toBe(8);
  });

  it('returns null once the task is gone', () => {
    const staleRow = {
      path: 'a.md',
      vaultId: '',
      line: 5,
      text: 'vanished',
      done: false,
      kind: 'tag' as const,
      heading: null,
      tags: [],
      due: null,
      priority: null,
    };
    expect(resolveTaskLine(doc, staleRow)).toBeNull();
  });

  it('keeps the recorded twin when it still sits there among duplicates', () => {
    const twins = '- [ ] buy milk\n\n- [ ] buy milk\n';
    const [row] = scanTasks('a.md', twins).filter((t) => t.text === 'buy milk');
    expect(row.line).toBe(1);
    expect(resolveTaskLine(twins, row)).toBe(1);
  });

  it('refuses to guess when duplicates shifted and the recorded line holds neither', () => {
    // One line inserted above shifts both twins; the row recorded line 1,
    // which now holds the SECOND twin. "Nearest" would mis-tick it.
    const twins = '- [ ] buy milk\n\n- [ ] buy milk\n';
    const [row] = scanTasks('a.md', twins).filter((t) => t.text === 'buy milk');
    const shifted = `\n${twins}`;
    expect(resolveTaskLine(shifted, row)).toBeNull();
  });
});
