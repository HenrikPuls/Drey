import { Type } from '@angular/core';
import { PanelId } from '../dock.service';
import { TemplatesPanel } from '../../templates';
import { CalendarPanel } from './calendar-panel';
import { EntryPanel } from './entry-panel';
import { FilesPanel } from './files-panel';
import { SearchPanelHost } from './search-panel-host';
import { WindowsPanel } from './windows-panel';
import { AssistantPanel } from './assistant-panel';

/**
 * Maps each panel id to its title (the mono-uppercase header label) and its
 * body component (rendered via `*ngComponentOutlet`, the same descriptor
 * pattern as `settings-category.ts`).
 */
export const PANEL_TITLES: Record<PanelId, string> = {
  calendar: 'Calendar',
  files: 'Files',
  templates: 'Templates',
  search: 'Search',
  windows: 'Open windows',
  assistant: 'Assistant',
  entry: 'Add entry',
};

export const PANEL_COMPONENTS: Record<PanelId, Type<unknown>> = {
  calendar: CalendarPanel,
  files: FilesPanel,
  templates: TemplatesPanel,
  search: SearchPanelHost,
  windows: WindowsPanel,
  assistant: AssistantPanel,
  entry: EntryPanel,
};
