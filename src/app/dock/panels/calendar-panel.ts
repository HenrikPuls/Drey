import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Calendar } from '../../calendar/calendar';

/**
 * "Calendar" dock panel -- hosts the mini-calendar, whose month row takes
 * the place of the panel title (`headerReplacesTitle` on the descriptor).
 */
@Component({
  selector: 'app-calendar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Calendar],
  template: `<app-calendar frameId="calendar" />`,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class CalendarPanel {}
