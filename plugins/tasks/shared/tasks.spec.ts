/**
 * The shared scanner's metadata contract (req-37): Obsidian-Tasks emoji
 * on the task line parse into `due` / `priority` and never leak into
 * `text` -- so a metadata edit cannot break `resolveTaskLine`'s
 * text+kind matching. The line setters round-trip: set, re-scan, remove.
 */
import { describe, expect, it } from 'vitest';
import {
  glyphOfPriority,
  priorityOfGlyph,
  resolveTaskLine,
  scanTasks,
  setDoneOnLine,
  setDueOnLine,
  setPriorityOnLine,
  isTaskLine,
  taskLineTokens,
  todayIso,
  dueState,
  type TaskRecord,
} from './tasks.js';

const scanOne = (line: string): TaskRecord => scanTasks('a.md', line)[0];

describe('scanTasks: metadata parsing', () => {
  it('checkbox with due and priority: both parsed, both stripped from text', () => {
    const task = scanOne('- [ ] Ship the release 📅 2026-10-09 ⏫');
    expect(task.text).toBe('Ship the release');
    expect(task.due).toBe('2026-10-09');
    expect(task.priority).toBe('high');
  });

  it('tokens in any order and position parse', () => {
    const task = scanOne('- [ ] 🔽 Tidy the shed 📅 2026-01-02');
    expect(task.text).toBe('Tidy the shed');
    expect(task.due).toBe('2026-01-02');
    expect(task.priority).toBe('low');
  });

  it('all three priority glyphs map', () => {
    expect(scanOne('- [ ] a 🔺')!.priority).toBe('highest');
    expect(scanOne('- [ ] a ⏫')!.priority).toBe('high');
    expect(scanOne('- [ ] a 🔽')!.priority).toBe('low');
    expect(scanOne('- [ ] a')!.priority).toBeNull();
    expect(scanOne('- [ ] a')!.due).toBeNull();
  });

  it('#task tag lines parse metadata too', () => {
    const task = scanOne('#task Call the bank 📅 2026-03-30 🔺');
    expect(task.kind).toBe('tag');
    expect(task.text).toBe('Call the bank');
    expect(task.due).toBe('2026-03-30');
    expect(task.priority).toBe('highest');
  });

  it('a malformed date is no due token', () => {
    expect(scanOne('- [ ] a 📅 2026-1-9')!.due).toBeNull();
    expect(scanOne('- [ ] a 📅 2026-01-01x')!.due).toBeNull();
    // The glued-in pseudo token stays in the text (it is ordinary content).
    expect(scanOne('- [ ] a 📅 2026-1-9')!.text).toBe('a 📅 2026-1-9');
  });

  it('emoji metadata survives inside a fenced example? no -- fences are skipped', () => {
    const doc = '```\n- [ ] example 📅 2026-10-09\n```\n';
    expect(scanTasks('a.md', doc)).toEqual([]);
  });

  it('glyph lookup helpers round-trip', () => {
    expect(priorityOfGlyph('🔺')).toBe('highest');
    expect(priorityOfGlyph('⏫')).toBe('high');
    expect(priorityOfGlyph('🔽')).toBe('low');
    expect(priorityOfGlyph('x')).toBeNull();
    expect(glyphOfPriority('highest')).toBe('🔺');
    expect(glyphOfPriority('high')).toBe('⏫');
    expect(glyphOfPriority('low')).toBe('🔽');
  });
});

describe('setDueOnLine', () => {
  it('appends when absent, replaces when present', () => {
    const first = setDueOnLine('- [ ] task', 1, '2026-10-09');
    expect(first).toBe('- [ ] task 📅 2026-10-09');
    const second = setDueOnLine(first, 1, '2026-11-01');
    expect(second).toBe('- [ ] task 📅 2026-11-01');
  });

  it('removal leaves no double gap and preserves the rest of the line', () => {
    const line = '  - [ ] mid 📅 2026-10-09 tail #proj';
    const next = setDueOnLine(line, 1, null);
    expect(next).toBe('  - [ ] mid tail #proj');
  });

  it('appending preserves leading indentation', () => {
    expect(setDueOnLine('\t- [ ] deep', 1, '2026-10-09')).toBe('\t- [ ] deep 📅 2026-10-09');
  });

  it('a malformed date and a non-task line change nothing', () => {
    expect(setDueOnLine('- [ ] a', 1, '2026-1-9')).toBe('- [ ] a');
    expect(setDueOnLine('plain text', 1, '2026-10-09')).toBe('plain text');
    expect(setDueOnLine('- [ ] a', 9, '2026-10-09')).toBe('- [ ] a');
  });

  it('setting an equal due date is a no-op', () => {
    expect(setDueOnLine('- [ ] a 📅 2026-10-09', 1, '2026-10-09')).toBe('- [ ] a 📅 2026-10-09');
  });

  it('works on a #task tag line', () => {
    expect(setDueOnLine('#task x', 1, '2026-02-03')).toBe('#task x 📅 2026-02-03');
  });
});

describe('setPriorityOnLine', () => {
  it('appends and replaces the glyph', () => {
    const first = setPriorityOnLine('- [ ] a', 1, 'high');
    expect(first).toBe('- [ ] a ⏫');
    expect(setPriorityOnLine(first, 1, 'highest')).toBe('- [ ] a 🔺');
  });

  it('removal returns to normal', () => {
    expect(setPriorityOnLine('- [ ] a 🔺', 1, null)).toBe('- [ ] a');
    expect(setPriorityOnLine('- [ ] a', 1, null)).toBe('- [ ] a');
  });

  it('due and priority setters compose', () => {
    let line = setDueOnLine('- [ ] a', 1, '2026-05-05');
    line = setPriorityOnLine(line, 1, 'low');
    const task = scanOne(line)!;
    expect(task.due).toBe('2026-05-05');
    expect(task.priority).toBe('low');
    expect(task.text).toBe('a');
  });
});

describe('taskLineTokens + date helpers', () => {
  it('returns the token spans of a task line, value-bearing and whitespace-exact', () => {
    const line = '- [ ] ship it 📅 2026-10-09 ⏫';
    expect(taskLineTokens(line)).toEqual([
      { from: 14, to: 27, kind: 'due', value: '2026-10-09' },
      { from: 28, to: 29, kind: 'priority', value: 'high' },
    ]);
  });

  it('is empty on non-task lines even when they carry the tokens', () => {
    expect(taskLineTokens('plain 📅 2026-10-09 text')).toEqual([]);
    expect(taskLineTokens('')).toEqual([]);
  });

  it('answers the task-line question for both kinds', () => {
    expect(isTaskLine('- [ ] a')).toBe(true);
    expect(isTaskLine('fix it #task')).toBe(true);
    expect(isTaskLine('- [x] done one')).toBe(true);
    expect(isTaskLine('just prose')).toBe(false);
  });

  it('classifies due dates against today', () => {
    expect(dueState('2026-01-01', '2026-10-09')).toBe('overdue');
    expect(dueState('2026-10-09', '2026-10-09')).toBe('today');
    expect(dueState('2026-12-24', '2026-10-09')).toBe('future');
    expect(todayIso(new Date(2026, 9, 9))).toBe('2026-10-09');
  });
});

describe('metadata does not disturb the toggle resolution', () => {
  it('a due/priority edit alone keeps resolveTaskLine on the task', () => {
    const before = scanOne('- [ ] unique text');
    const edited = setDueOnLine(setPriorityOnLine('- [ ] unique text', 1, 'high'), 1, '2026-10-09');
    expect(resolveTaskLine(edited, before)).toBe(1);
  });

  it('toggling done preserves metadata', () => {
    const line = setDoneOnLine('- [ ] a 📅 2026-10-09 ⏫', 1, true);
    const task = scanOne(line)!;
    expect(task.done).toBe(true);
    expect(task.due).toBe('2026-10-09');
    expect(task.priority).toBe('high');
  });

  it('the box flip keeps the tokens in place', () => {
    expect(setDoneOnLine('- [ ] a 📅 2026-10-09', 1, true)).toBe('- [x] a 📅 2026-10-09');
  });
});
