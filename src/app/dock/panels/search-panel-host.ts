import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SearchPanel } from '../../tags';

/** "Search" dock panel -- hosts the existing tag-search panel. */
@Component({
  selector: 'app-search-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SearchPanel],
  template: `<app-search-panel [embedded]="true" />`,
  styles: `
    :host {
      display: block;
      padding: 0 12px 12px;
    }
  `,
})
export class SearchPanelHost {}
