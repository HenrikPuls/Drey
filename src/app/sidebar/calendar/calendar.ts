import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CalendarDay, CalendarService, WEEKDAY_INITIALS } from '../../services/calendar.service';
import { EditorService } from '../../services/editor.service';
import { Icon } from '../../icons/icon';

/**
 * Sidebar mini-calendar. View state (shown month, selected day) lives in
 * `CalendarService`; clicking a day selects it and opens that day's daily
 * note via `EditorService.openDailyNote()` -- which opens the existing file
 * or, for a day with no note yet, an unsaved draft that only hits disk once
 * the user types and saves.
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

  protected onDayClick(day: CalendarDay): void {
    this.cal.select(day.iso);
    void this.editor.openDailyNote(day.iso);
  }
}
