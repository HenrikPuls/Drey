import {
  completionKey,
  resolveTaskLine,
  scanTasks,
  setDoneOnLine,
  sortTaskRecords,
  syncCompletionDateOnLineText,
} from './tasks';

/** A single quote, for building quoted YAML scalars in expectations. */
const QUOTE = String.fromCharCode(39);

/**
 * The Tasks plugin's pure scanner (`plugins/tasks/shared/tasks`), relocated
 * from `src/app/tasks/` at the ADR-0044 stage-6 conversion.
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
        completed: null,
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
        completed: null,
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
        completed: null,
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
        completed: null,
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
        completed: null,
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
        completed: null,
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
    expect(setDoneOnLine(doc, 1, true, '2026-10-10')).toBe('- [x] a ✅ 2026-10-10\n- [x] b\n');
    expect(setDoneOnLine(doc, 2, false)).toBe('- [ ] a\n- [ ] b\n');
    expect(setDoneOnLine(doc, 1, false)).toBe(doc);
    // Already done: a legacy line never gains a date it did not earn today.
    expect(setDoneOnLine(doc, 2, true, '2026-10-10')).toBe(doc);
  });

  it('adds and removes #task/done on a bare #task line', () => {
    expect(setDoneOnLine('water plants #task\n', 1, true, '2026-10-10')).toBe(
      'water plants #task ✅ 2026-10-10 #task/done\n',
    );
    expect(setDoneOnLine('water plants #task #task/done\n', 1, false)).toBe('water plants #task\n');
    expect(setDoneOnLine('water plants #task ✅ 2026-10-10 #task/done\n', 1, false)).toBe(
      'water plants #task\n',
    );
  });

  it('reopening removes the completion date and keeps the other metadata (57d)', () => {
    expect(setDoneOnLine('- [x] a 📅 2026-10-09 ✅ 2026-10-10 ⏫\n', 1, false)).toBe(
      '- [ ] a 📅 2026-10-09 ⏫\n',
    );
  });

  it('syncs the date to a box someone else flipped (the editor toggles)', () => {
    expect(syncCompletionDateOnLineText('- [x] a', '2026-10-10')).toBe('- [x] a ✅ 2026-10-10');
    expect(syncCompletionDateOnLineText('- [x] a ✅ 2026-10-01', '2026-10-10')).toBe(
      '- [x] a ✅ 2026-10-01',
    );
    expect(syncCompletionDateOnLineText('- [ ] a ✅ 2026-10-01', '2026-10-10')).toBe('- [ ] a');
    expect(syncCompletionDateOnLineText('- [ ] a', '2026-10-10')).toBe('- [ ] a');
    expect(syncCompletionDateOnLineText('prose', '2026-10-10')).toBe('prose');
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

describe('scanTasks — meeting-import text metadata (57a)', () => {
  it('parses and strips a `due:` prefix into the due field (checkbox+#task line)', () => {
    const doc = '- [ ] #task due: 2026-09-04 Marta: Zwei-Ebenen-These ausformulieren\n';
    const [task] = scanTasks('n.md', doc);
    // Checkbox + #task on one line reports once, as checkbox (file header).
    expect(task).toMatchObject({
      due: '2026-09-04',
      done: false,
      kind: 'checkbox',
      text: 'Marta: Zwei-Ebenen-These ausformulieren',
    });
  });

  it('a `done:` date marks the task done and strips away (checkbox and tag)', () => {
    const doc =
      '- [x] #task done: 2026-09-19 Treffenraum reservieren\n- [ ] #task done: 2026-09-20 Nachtragen\n';
    const tasks = scanTasks('n.md', doc);
    expect(tasks[0]).toMatchObject({ done: true, text: 'Treffenraum reservieren' });
    // Unchecked box, but the done: date completes it (the meeting form).
    expect(tasks[1]).toMatchObject({ done: true, text: 'Nachtragen' });
  });

  it('a checkbox-only line with a `due:` prefix parses too (daily-note style)', () => {
    const doc = '- [ ] due: 2026-09-21 Callender-Kapitel 3 exzerpieren\n';
    const [task] = scanTasks('n.md', doc);
    expect(task).toMatchObject({
      due: '2026-09-21',
      done: false,
      kind: 'checkbox',
      text: 'Callender-Kapitel 3 exzerpieren',
    });
  });

  it('the emoji form wins when both forms sit on one line; both are stripped', () => {
    const doc = '- [ ] due: 2026-01-01 alt 📅 2026-05-05 neu Task\n';
    const [task] = scanTasks('n.md', doc);
    expect(task).toMatchObject({ due: '2026-05-05', text: 'alt neu Task' });
  });

  it('the `done:` date is the completion date', () => {
    const [task] = scanTasks('n.md', '- [x] #task done: 2026-09-19 Treffenraum reservieren\n');
    expect(task.completed).toBe('2026-09-19');
  });

  it('near-miss words stay in the text (no colon match, no partial dates)', () => {
    const doc = '- [ ] overdue: notes and dueless ideas\n';
    const [task] = scanTasks('n.md', doc);
    expect(task).toMatchObject({ due: null, done: false, text: 'overdue: notes and dueless ideas' });
  });
});

describe('completion date (57d)', () => {
  it('parses `✅ YYYY-MM-DD` into completed and strips it from the text', () => {
    const [task] = scanTasks('n.md', '- [x] ship it ✅ 2026-10-08 📅 2026-10-09\n');
    expect(task).toMatchObject({
      text: 'ship it',
      done: true,
      completed: '2026-10-08',
      due: '2026-10-09',
    });
  });

  it('the date alone never marks a task done', () => {
    const [task] = scanTasks('n.md', '- [ ] ship it ✅ 2026-10-08\n');
    expect(task).toMatchObject({ done: false, completed: '2026-10-08' });
  });

  it('a toggled line still resolves to the same task (text is date-free)', () => {
    const [before] = scanTasks('n.md', '- [ ] unique text\n');
    const toggled = setDoneOnLine('- [ ] unique text\n', 1, true, '2026-10-10');
    expect(resolveTaskLine(toggled, before)).toBe(1);
  });

  it('completionKey: the written date, else the date in the file name, else null', () => {
    expect(completionKey({ path: 'daily/2026/10/2026-10-02.md', completed: '2026-10-09' })).toBe(
      '2026-10-09',
    );
    expect(completionKey({ path: 'daily/2026/10/2026-10-02.md', completed: null })).toBe(
      '2026-10-02',
    );
    expect(completionKey({ path: 'meetings/2026-08-14-kickoff.md' })).toBe('2026-08-14');
    expect(completionKey({ path: 'projects/2026-01-01/plan.md', completed: null })).toBeNull();
  });

  it('the completed sort lists newest first, undated last', () => {
    const row = (path: string, completed: string | null) => ({
      path,
      line: 1,
      due: null,
      priority: null,
      completed,
    });
    const sorted = sortTaskRecords(
      [
        row('plan.md', null),
        row('daily/2026-09-20.md', null),
        row('a.md', '2026-10-09'),
        row('b.md', '2026-10-01'),
      ],
      'completed',
    );
    expect(sorted.map((t) => t.path)).toEqual(['a.md', 'b.md', 'daily/2026-09-20.md', 'plan.md']);
  });
});
