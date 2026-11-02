import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The wide layout's idle center pane (the prototype's #v-empty): the
 * shell shows it while no ticket, persona detail, team list or chat
 * claims the middle column.
 */
@Component({
  selector: 'mc-empty',
  templateUrl: './empty.html',
  styleUrl: './empty.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Empty {}
