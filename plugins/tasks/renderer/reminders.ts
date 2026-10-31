/**
 * Due-date reminders (req-65): ONE system notification per local day —
 * a counts-only digest, never one toast per task — when any OPEN task
 * with `due <= today` exists across every registered vault. The digest
 * is re-evaluated whenever the task index settles (the panel's re-pull
 * after `index-updated` / save / refresh) and once a minute while Drey
 * runs, so the midnight day rollover is caught without a watcher of its
 * own. While Drey is closed nothing fires: no background process, no
 * OS-scheduled toast — the next start's digest covers every open
 * overdue task, so a missed reminder arrives once, late, not per day.
 *
 * Everything that can vary is a seam (clock, tasks, settings, notify),
 * so the spec drives days and fires without DOM or Electron — the
 * settings-page DOM is thin; this controller is the risk.
 */
import type { NotifyRequest } from '../../../shared/plugin-api/renderer';
import { dueState, todayIso, type TaskRecord } from '../shared/tasks.js';

/** Open tasks with `due <= today`, split for the digest. */
export interface ReminderDigest {
  readonly dueToday: readonly TaskRecord[];
  readonly overdue: readonly TaskRecord[];
}

/**
 * The digest of `tasks` against `today` (`YYYY-MM-DD`), or `null` when
 * nothing is due. Done and undated tasks never count; future tasks
 * never count. The comparison is `dueState`'s — never reimplemented.
 */
export function reminderDigest(tasks: readonly TaskRecord[], today: string): ReminderDigest | null {
  const dueToday: TaskRecord[] = [];
  const overdue: TaskRecord[] = [];
  for (const task of tasks) {
    if (task.done || task.due === null) {
      continue;
    }
    const state = dueState(task.due, today);
    if (state === 'today') {
      dueToday.push(task);
    } else if (state === 'overdue') {
      overdue.push(task);
    }
  }
  return dueToday.length > 0 || overdue.length > 0 ? { dueToday, overdue } : null;
}

/**
 * The notification for a digest: title/body per the req-65 wording
 * table (pluralization included), `tag: 'tasks-due'` so a later digest
 * replaces the earlier toast instead of stacking in the Action Center.
 */
export function digestNotification(digest: ReminderDigest, onClick: () => void): NotifyRequest {
  const todayCount = digest.dueToday.length;
  const overdueCount = digest.overdue.length;
  if (todayCount > 0 && overdueCount > 0) {
    return {
      title: 'Tasks due today',
      body: `${todayCount} due today, ${overdueCount} overdue`,
      tag: 'tasks-due',
      onClick,
    };
  }
  if (todayCount > 0) {
    return {
      title: 'Tasks due today',
      body: `${todayCount} task${todayCount === 1 ? '' : 's'} due today`,
      tag: 'tasks-due',
      onClick,
    };
  }
  return {
    title: 'Overdue tasks',
    body: `${overdueCount} task${overdueCount === 1 ? ' is' : 's are'} overdue`,
    tag: 'tasks-due',
    onClick,
  };
}

/** The injectable halves the controller needs (all renderer-side). */
export interface ReminderSeams {
  /** The panel's disk index (`state.vaultTasks`) — every vault, NOT buffer hits. */
  getTasks(): readonly TaskRecord[];
  /** The one clock; `todayIso()` derives from it. Never a bare `new Date()` here. */
  now(): Date;
  /** `remindersEnabled` from the plugin config; absent = on. */
  isEnabled(): Promise<boolean>;
  /** `remindersLastDay` from the plugin config (the day gate). */
  lastDay(): Promise<string | undefined>;
  setLastDay(day: string): Promise<void>;
  /** Fire-and-forget wrapper over `api.ui.notify`. */
  notify(request: NotifyRequest): void;
  /** Runs after the window came to front on a click: reveal the panel. */
  onClick(): void;
  /** The rollover poll interval; default one minute. */
  readonly intervalMs?: number;
}

/**
 * The digest controller. `check()` is safe to call on every index
 * settle: it returns early when disabled or already reminded today —
 * WITHOUT writing the gate — and on an empty digest (a boot check
 * before the index settled must not silence the day). It fires at most
 * one notification per local day and stores the day when it fired, also
 * when the system ends up showing nothing (`ui.notify` resolves false
 * on denied permission; that must not re-fire on the next save's push).
 * `stop()` clears the interval (call it from `deactivate`).
 */
export function startReminders(seams: ReminderSeams): { check(): Promise<void>; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const check = async (): Promise<void> => {
    if (running) {
      // Saves burst; the in-flight check covers this trigger, and the
      // minute poll re-evaluates whatever landed after it started.
      return;
    }
    running = true;
    try {
      const today = todayIso(seams.now());
      if (!(await seams.isEnabled()) || (await seams.lastDay()) === today) {
        return;
      }
      const digest = reminderDigest(seams.getTasks(), today);
      if (digest === null) {
        return;
      }
      seams.notify(digestNotification(digest, seams.onClick));
      await seams.setLastDay(today);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void check(), seams.intervalMs ?? 60_000);
  return {
    check,
    stop: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
