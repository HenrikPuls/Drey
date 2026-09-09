import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NoteAssistant } from '../../assistant/note-assistant';

/**
 * "Assistant" dock panel -- hosts the note assistant. Unlike the other
 * panels it fills the frame and scrolls internally (its own header +
 * composer stay put); `PanelFrame` gives this panel a flex body instead of
 * a scrolling one.
 */
@Component({
  selector: 'app-assistant-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NoteAssistant],
  template: `<app-note-assistant />`,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    :host ::ng-deep app-note-assistant {
      flex: 1;
      min-height: 0;
      /* It already draws its own left border for the old right-column look. */
      border-left: 0;
    }
  `,
})
export class AssistantPanel {}
