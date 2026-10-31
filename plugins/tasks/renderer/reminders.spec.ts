/**
 * The due-date reminder controller (`reminders.ts`, req-65), pure and
 * DOM-free: every half the controller needs is a fake seam (the
 * `task-meta.spec.ts` style), so the spec drives days, gates and fires
 * without Electron. The pinned contract: at most one notification per
 * local day, the day gate written ONLY when a notification actually
 * fired (a disabled switch, an already-reminded day and an empty
 * digest — the boot check before the index settled — never burn the
 * day), and `stop()` clears the interval.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NotifyRequest } from '../../../shared/plugin-api/renderer';
import { scanTasks, type TaskRecord } from '../shared/tasks.js';
import {
  digestNotification,
  reminderDigest,
  startReminders,
  type ReminderDigest,
  type ReminderSeams,
} from './reminders.js';

/** 2026-10-31, local time — the spec's "today". */
const NOW = new Date(2026, 9, 31);
const TODAY = '2026-10-31';

/** The mutable half behind the fake seams. */
interface SeamsState {
  tasks: TaskRecord[];
  now: Date;
  /** What `isEnabled` resolves; `undefined` = key absent = on. */
  enabled: boolean | undefined;
  /** What `lastDay` resolves (the stored gate). */
  lastDay: string | undefined;
  /** Every `setLastDay` call, in order. */
  storedDays: string[];
  notified: NotifyRequest[];
  clicks: number;
}

function fakeSeams(overrides: Partial<SeamsState> = {}): { seams: ReminderSeams; state: SeamsState } {
  const state: SeamsState = {
    tasks: [],
    now: NOW,
    enabled: undefined,
    lastDay: undefined,
    storedDays: [],
    notified: [],
    clicks: 0,
    ...overrides,
  };
  const seams: ReminderSeams = {
    getTasks: () => state.tasks,
    now: () => state.now,
    isEnabled: () => Promise.resolve(state.enabled !== false),
    lastDay: () => Promise.resolve(state.lastDay),
    setLastDay: (day) => {
      state.storedDays.push(day);
      state.lastDay = day;
      return Promise.resolve();
    },
    notify: (request) => {
      state.notified.push(request);
    },
    onClick: () => {
      state.clicks += 1;
    },
  };
  return { seams, state };
}

/** One open task due `date`, built through the real scanner. */
function dueTask(date: string, done = false): TaskRecord {
  return scanTasks('notes/a.md', `- [${done ? 'x' : ' '}] task due ${date} 📅 ${date}\n`, 'v1')[0]!;
}

describe('reminderDigest', () => {
  it('splits open tasks into overdue and due today; done and future never count', () => {
    const tasks = [
      dueTask('2026-10-29'), // overdue
      dueTask('2026-10-30', true), // overdue but done — excluded
      dueTask(TODAY), // due today
      dueTask(TODAY, true), // due today but done — excluded
      dueTask('2026-11-02'), // future — excluded
      dueTask('2026-11-02', true), // future and done — excluded
    ];
    const digest = reminderDigest(tasks, TODAY);
    expect(digest).not.toBeNull();
    expect(digest!.dueToday.map((t) => t.due)).toEqual([TODAY]);
    expect(digest!.overdue.map((t) => t.due)).toEqual(['2026-10-29']);
  });

  it('reads real scanned lines: metadata, done flags and all vaults', () => {
    const tasks = [
      ...scanTasks('daily/2026-10-30.md', '- [ ] call Anna 📅 2026-10-30\n- [x] filed 📅 2026-10-30\n', 'v1'),
      ...scanTasks('project.md', '- [ ] ship it 📅 2026-10-31\n#task write back 📅 2026-10-30\n', 'v2'),
    ];
    const digest = reminderDigest(tasks, TODAY);
    expect(digest!.overdue.map((t) => `${t.vaultId}:${t.text}`)).toEqual(['v1:call Anna', 'v2:write back']);
    expect(digest!.dueToday.map((t) => `${t.vaultId}:${t.text}`)).toEqual(['v2:ship it']);
  });

  it('is null when nothing is due and when everything due is done', () => {
    expect(reminderDigest([], TODAY)).toBeNull();
    expect(reminderDigest([dueTask('2026-11-05')], TODAY)).toBeNull();
    expect(reminderDigest([dueTask('2026-10-30', true), dueTask(TODAY, true)], TODAY)).toBeNull();
  });
});

describe('digestNotification', () => {
  /** A digest of n + m records — the wording only counts. */
  const digestOf = (todayCount: number, overdueCount: number): ReminderDigest => ({
    dueToday: Array.from({ length: todayCount }, (_, i) => ({ ...dueTask(TODAY), text: `t${i}` })),
    overdue: Array.from({ length: overdueCount }, (_, i) => ({ ...dueTask('2026-10-30'), text: `o${i}` })),
  });

  it('words the mixed digest as counts only', () => {
    const n = digestNotification(digestOf(2, 4), () => undefined);
    expect(n.title).toBe('Tasks due today');
    expect(n.body).toBe('2 due today, 4 overdue');
  });

  it('pluralizes the due-today-only body', () => {
    const one = digestNotification(digestOf(1, 0), () => undefined);
    expect(one.title).toBe('Tasks due today');
    expect(one.body).toBe('1 task due today');
    const three = digestNotification(digestOf(3, 0), () => undefined);
    expect(three.body).toBe('3 tasks due today');
  });

  it('pluralizes the overdue-only title and body', () => {
    const one = digestNotification(digestOf(0, 1), () => undefined);
    expect(one.title).toBe('Overdue tasks');
    expect(one.body).toBe('1 task is overdue');
    const four = digestNotification(digestOf(0, 4), () => undefined);
    expect(four.title).toBe('Overdue tasks');
    expect(four.body).toBe('4 tasks are overdue');
  });

  it('tags every digest tasks-due so a later one replaces the earlier toast', () => {
    for (const n of [
      digestNotification(digestOf(1, 1), () => undefined),
      digestNotification(digestOf(1, 0), () => undefined),
      digestNotification(digestOf(0, 1), () => undefined),
    ]) {
      expect(n.tag).toBe('tasks-due');
    }
  });

  it('carries the click callback', () => {
    let clicked = false;
    const n = digestNotification(digestOf(1, 0), () => {
      clicked = true;
    });
    n.onClick!();
    expect(clicked).toBe(true);
  });
});

describe('startReminders.check', () => {
  it('fires once on a non-empty digest and stores the day', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]!.title).toBe('Tasks due today');
    expect(state.storedDays).toEqual([TODAY]);
    reminders.stop();
  });

  it('the gate blocks a repeat within the same day', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
    const reminders = startReminders(seams);
    await reminders.check();
    await reminders.check();
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    expect(state.storedDays).toEqual([TODAY]);
    reminders.stop();
  });

  it('the gate also blocks when it was set on an earlier run', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)], lastDay: TODAY });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(0);
    expect(state.storedDays).toEqual([]);
    reminders.stop();
  });

  it('an empty digest notifies nothing and does NOT burn the day', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask('2026-11-05')] });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(0);
    expect(state.storedDays).toEqual([]);
    reminders.stop();
  });

  it('disabled neither notifies nor stores', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)], enabled: false });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(0);
    expect(state.storedDays).toEqual([]);
    reminders.stop();
  });

  it('a day rollover fires again: the digest of the new day notifies once more', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    // Midnight passes — the same task is now overdue, still open, still due.
    state.now = new Date(2026, 10, 1);
    await reminders.check();
    expect(state.notified).toHaveLength(2);
    expect(state.notified[1]!.title).toBe('Overdue tasks');
    expect(state.storedDays).toEqual(['2026-10-31', '2026-11-01']);
    reminders.stop();
  });

  it('a task that only becomes due after an empty day still notifies then', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask('2026-11-01')] });
    const reminders = startReminders(seams);
    await reminders.check(); // future on the 31st — nothing stored
    state.now = new Date(2026, 10, 1);
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    expect(state.storedDays).toEqual(['2026-11-01']);
    reminders.stop();
  });

  it('stores the day without consulting the notify result (permission denied must not re-fire)', async () => {
    // The notify seam is fire-and-forget by contract: `ui.notify`
    // resolving false (system showed nothing) cannot un-store the day.
    const { seams, state } = fakeSeams({ tasks: [dueTask('2026-10-30')] });
    const reminders = startReminders(seams);
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    expect(state.storedDays).toEqual([TODAY]);
    await reminders.check();
    expect(state.notified).toHaveLength(1);
    reminders.stop();
  });

  it('wires the notification click to the seam onClick (reveal the panel)', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
    const reminders = startReminders(seams);
    await reminders.check();
    state.notified[0]!.onClick!();
    expect(state.clicks).toBe(1);
    reminders.stop();
  });

  it('a burst of concurrent checks notifies once (the in-flight guard)', async () => {
    const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
    const reminders = startReminders(seams);
    const [a, b] = [reminders.check(), reminders.check()];
    await Promise.all([a, b]);
    expect(state.notified).toHaveLength(1);
    expect(state.storedDays).toEqual([TODAY]);
    reminders.stop();
  });
});

describe('startReminders interval', () => {
  it('polls every minute by default and re-checks after a day rollover', async () => {
    vi.useFakeTimers();
    try {
      const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
      const reminders = startReminders(seams);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state.notified).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.notified).toHaveLength(1);
      // The day turns; only the poll catches it (no save happened).
      state.now = new Date(2026, 10, 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.notified).toHaveLength(2);
      reminders.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears the interval', async () => {
    vi.useFakeTimers();
    try {
      const { seams, state } = fakeSeams({ tasks: [dueTask(TODAY)] });
      const reminders = startReminders(seams);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.notified).toHaveLength(1);
      reminders.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(state.notified).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
