import { Injectable, computed, inject, signal } from '@angular/core';
import { dailyDateFromPath } from '../../../shared/daily';
import { formatDate } from '../../../shared/timestamp';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { VaultService } from './vault.service';

/** One cell in the mini-calendar grid. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  readonly iso: string;
  readonly dayOfMonth: number;
  /** False for the leading/trailing days that belong to the adjacent month. */
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly isSelected: boolean;
  readonly hasNote: boolean;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Abbreviated month names for the month/year picker grid. */
export const MONTH_SHORT_NAMES = MONTH_NAMES.map((m) => m.slice(0, 3));

/** Monday-first weekday initials, matching the prototype's grid. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * View state for the sidebar mini-calendar: which month is shown and which
 * day is selected. Opening a day's note is not done here -- the `Calendar`
 * component calls `EditorService.openDailyNote()` -- this service only owns
 * the calendar's own state plus the "does this day have a note?" lookup,
 * derived from the vault file tree (`daily/<year>/<month>/YYYY-MM-DD.md`,
 * or a legacy flat `daily/YYYY-MM-DD.md`).
 */
@Injectable({ providedIn: 'root' })
export class CalendarService {
  private readonly vault = inject(VaultService);

  private readonly today = new Date();

  readonly viewYear = signal(this.today.getFullYear());
  readonly viewMonth = signal(this.today.getMonth()); // 0-11
  readonly selectedIso = signal<string>(formatDate(this.today));

  /** Year/month of the real "today", for highlighting in the picker grid. */
  readonly todayYear = this.today.getFullYear();
  readonly todayMonth = this.today.getMonth();

  readonly monthLabel = computed(() => `${MONTH_NAMES[this.viewMonth()]} ${this.viewYear()}`);

  /**
   * Set of `YYYY-MM-DD` for which a `daily/` note exists in the vault.
   * Walks the whole `daily/` subtree so both the nested
   * `daily/<year>/<month>/` layout and any legacy flat files are counted;
   * `dailyDateFromPath` recognises either.
   */
  private readonly noteDates = computed<ReadonlySet<string>>(() => {
    const daily = this.vault.fileTree().find((e) => e.type === 'directory' && e.name === 'daily');
    const dates = new Set<string>();
    const walk = (entries: readonly VaultFileEntry[]): void => {
      for (const entry of entries) {
        if (entry.type === 'directory') {
          walk(entry.children ?? []);
        } else {
          const date = dailyDateFromPath(entry.relativePath);
          if (date) {
            dates.add(date);
          }
        }
      }
    };
    walk(daily?.children ?? []);
    return dates;
  });

  readonly weeks = computed<CalendarDay[][]>(() => {
    const year = this.viewYear();
    const month = this.viewMonth();
    const todayIso = formatDate(this.today);
    const selected = this.selectedIso();
    const notes = this.noteDates();

    const firstOfMonth = new Date(year, month, 1);
    // Monday = 0 … Sunday = 6.
    const lead = (firstOfMonth.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - lead);

    const weeks: CalendarDay[][] = [];
    const cursor = start;
    // Six rows is always enough to cover any month with any lead.
    for (let week = 0; week < 6; week++) {
      const row: CalendarDay[] = [];
      for (let d = 0; d < 7; d++) {
        const dayIso = formatDate(cursor);
        row.push({
          iso: dayIso,
          dayOfMonth: cursor.getDate(),
          inMonth: cursor.getMonth() === month,
          isToday: dayIso === todayIso,
          isSelected: dayIso === selected,
          hasNote: notes.has(dayIso),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(row);
    }
    return weeks;
  });

  prevMonth(): void {
    const m = this.viewMonth();
    if (m === 0) {
      this.viewMonth.set(11);
      this.viewYear.update((y) => y - 1);
    } else {
      this.viewMonth.set(m - 1);
    }
  }

  nextMonth(): void {
    const m = this.viewMonth();
    if (m === 11) {
      this.viewMonth.set(0);
      this.viewYear.update((y) => y + 1);
    } else {
      this.viewMonth.set(m + 1);
    }
  }

  /** Jump the shown month directly, e.g. from the month/year picker. */
  setMonth(year: number, month: number): void {
    this.viewYear.set(year);
    this.viewMonth.set(month);
  }

  select(dayIso: string): void {
    this.selectedIso.set(dayIso);
    const [y, m] = dayIso.split('-').map(Number);
    this.viewYear.set(y);
    this.viewMonth.set(m - 1);
  }
}
