import { ChangeDetectionStrategy, Component, Injectable, input, output, signal } from '@angular/core';
import { MD_MODES, MD_MODE_LABEL, type MdMode } from '../markdown/mode';

/**
 * The text mode the owner edits in (E13-23): Live or Source. Shared by the
 * ticket view (which enters editing from the header switch) and the editor
 * overlay (which shows the same switch); View is the reading mode, not an
 * editing one, so it is never stored here.
 */
@Injectable({ providedIn: 'root' })
export class TicketEditMode {
  readonly mode = signal<Exclude<MdMode, 'view'>>('live');
}

/**
 * The Live | View | Source switch in the ticket header, in the place the edit
 * pencil had (E13-23). View is where the ticket is read; Live and Source are
 * how the owner edits. The look is the Markdown surface's own `.mdx-seg`.
 */
@Component({
  selector: 'mc-ticket-mode',
  template: `
    <div class="mdx-seg" role="group" aria-label="Ticket text mode">
      @for (m of modes; track m) {
        <button type="button" class="mdx-seg-btn" [attr.aria-pressed]="active() === m" (click)="pick.emit(m)">
          {{ label[m] }}
        </button>
      }
    </div>
  `,
  styles: [':host { display: inline-flex; flex: none; margin-left: 8px; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketModeSwitch {
  readonly active = input.required<MdMode>();
  readonly pick = output<MdMode>();
  protected readonly modes = MD_MODES;
  protected readonly label = MD_MODE_LABEL;
}
