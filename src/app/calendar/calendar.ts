import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  CalendarDay,
  CalendarService,
  MONTH_SHORT_NAMES,
  WEEKDAY_INITIALS,
} from './calendar.service';
import { EditorService } from '../services/editor.service';
import { Icon } from '../icons/icon';

/**
 * Sidebar mini-calendar. View state (shown month, selected day) lives in
 * `CalendarService`; clicking a day selects it and opens that day's daily
 * note via `EditorService.openDailyNote()` -- which opens the existing file
 * or, for a day with no note yet, an unsaved draft that only hits disk once
 * the user types and saves.
 *
 * Clicking the header label swaps the day grid for a month/year picker
 * instead of opening a second popover: the existing ‹ › buttons then step
 * the year, so there is only ever one set of controls on screen. The picker
 * browses a year of its own (`pickerYear`) and only commits to the shown
 * month once a month cell is clicked -- paging through years does not move
 * the calendar underneath.
 */
@Component({
  selector: 'app-calendar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './calendar.html',
  styleUrl: './calendar.css',
})
export class Calendar {
  protected readonly cal = inject(CalendarService);
  private readonly editor = inject(EditorService);

  protected readonly weekdays = WEEKDAY_INITIALS;
  protected readonly months = MONTH_SHORT_NAMES;

  protected readonly pickerOpen = signal(false);
  protected readonly pickerYear = signal(this.cal.viewYear());

  protected readonly headLabel = computed(() =>
    this.pickerOpen() ? String(this.pickerYear()) : this.cal.monthLabel(),
  );
  protected readonly stepUnit = computed(() => (this.pickerOpen() ? 'year' : 'month'));

  protected onDayClick(day: CalendarDay): void {
    this.cal.select(day.iso);
    void this.editor.openDailyNote(day.iso);
  }

  protected togglePicker(): void {
    if (this.pickerOpen()) {
      this.pickerOpen.set(false);
      return;
    }
    this.pickerYear.set(this.cal.viewYear());
    this.pickerOpen.set(true);
  }

  protected onPrev(): void {
    if (this.pickerOpen()) {
      this.pickerYear.update((y) => y - 1);
    } else {
      this.cal.prevMonth();
    }
  }

  protected onNext(): void {
    if (this.pickerOpen()) {
      this.pickerYear.update((y) => y + 1);
    } else {
      this.cal.nextMonth();
    }
  }

  protected onMonthClick(month: number): void {
    this.cal.setMonth(this.pickerYear(), month);
    this.pickerOpen.set(false);
  }

  protected isShownMonth(month: number): boolean {
    return this.pickerYear() === this.cal.viewYear() && month === this.cal.viewMonth();
  }

  protected isCurrentMonth(month: number): boolean {
    return this.pickerYear() === this.cal.todayYear && month === this.cal.todayMonth;
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.pickerOpen.set(false);
  }
}
