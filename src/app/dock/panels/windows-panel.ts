import { ChangeDetectionStrategy, Component } from '@angular/core';
import { OpenWindows } from '../../windows/open-windows';

/** "Open windows" dock panel -- mirrors the open editor tabs. */
@Component({
  selector: 'app-windows-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OpenWindows],
  template: `<app-open-windows />`,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class WindowsPanel {}
