import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Calendar } from '../../calendar/calendar';

/** "Calendar" dock panel -- hosts the existing mini-calendar. */
@Component({
  selector: 'app-calendar-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Calendar],
  template: `<app-calendar />`,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class CalendarPanel {}
