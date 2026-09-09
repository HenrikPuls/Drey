import { scanTasks, setDoneOnLine } from '../../../shared/tasks';

describe('scanTasks', () => {
  it('finds checkbox tasks with their done-state and text', () => {
    const doc = '- [ ] buy milk\n- [x] call Anna\n  - [X] nested and done\n';
    expect(scanTasks('n.md', doc)).toEqual([
      { path: 'n.md', line: 1, text: 'buy milk', done: false, kind: 'checkbox', heading: null },
      { path: 'n.md', line: 2, text: 'call Anna', done: true, kind: 'checkbox', heading: null },
      {
        path: 'n.md',
        line: 3,
        text: 'nested and done',
        done: true,
        kind: 'checkbox',
        heading: null,
      },
    ]);
  });

  it('finds #task lines, done only when #task/done is present', () => {
    const doc = 'Fix the roof #task\nMow the lawn #task #task/done\n';
    const tasks = scanTasks('n.md', doc);
    expect(tasks).toEqual([
      { path: 'n.md', line: 1, text: 'Fix the roof', done: false, kind: 'tag', heading: null },
      { path: 'n.md', line: 2, text: 'Mow the lawn', done: true, kind: 'tag', heading: null },
    ]);
  });

  it('reports a checkbox+#task line once, as a checkbox', () => {
    const tasks = scanTasks('n.md', '- [ ] ship it #task\n');
    expect(tasks).toEqual([
      { path: 'n.md', line: 1, text: 'ship it', done: false, kind: 'checkbox', heading: null },
    ]);
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
});

describe('setDoneOnLine', () => {
  it('flips a checkbox both ways and is a no-op when already in state', () => {
    const doc = '- [ ] a\n- [x] b\n';
    expect(setDoneOnLine(doc, 1, true)).toBe('- [x] a\n- [x] b\n');
    expect(setDoneOnLine(doc, 2, false)).toBe('- [ ] a\n- [ ] b\n');
    expect(setDoneOnLine(doc, 1, false)).toBe(doc);
  });

  it('adds and removes #task/done on a bare #task line', () => {
    expect(setDoneOnLine('water plants #task\n', 1, true)).toBe(
      'water plants #task #task/done\n',
    );
    expect(setDoneOnLine('water plants #task #task/done\n', 1, false)).toBe(
      'water plants #task\n',
    );
  });

  it('leaves a non-task line and an out-of-range line untouched', () => {
    expect(setDoneOnLine('just prose\n', 1, true)).toBe('just prose\n');
    expect(setDoneOnLine('- [ ] a\n', 9, true)).toBe('- [ ] a\n');
  });
});
