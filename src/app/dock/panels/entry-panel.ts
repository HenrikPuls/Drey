import { ChangeDetectionStrategy, Component } from '@angular/core';
import { EntryDrawer } from '../../entry-drawer/entry-drawer';

/**
 * "Add entry" dock panel -- hosts the capture drawer. Its default home is
 * the bottom dock (the old fixed strip under the editor), but it is now a
 * normal movable/collapsible panel.
 */
@Component({
  selector: 'app-entry-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EntryDrawer],
  template: `<app-entry-drawer />`,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class EntryPanel {}
