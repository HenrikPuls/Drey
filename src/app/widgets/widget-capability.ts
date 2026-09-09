/**
 * The read surfaces a dock widget declares it uses. Purely descriptive for
 * now -- surfaced in Settings -> Widgets (milestone 18) and documented as
 * the seam a future capability check would enforce. There is no runtime
 * gating and no sandbox: every registered widget can reach all of
 * `WidgetContext` (ADR-0034).
 */
export type WidgetCapability =
  | 'active-document'
  | 'file-tree'
  | 'tag-queries'
  | 'task-queries'
  | 'search'
  | 'commands';

/** Human labels for the capability chips in Settings. */
export const WIDGET_CAPABILITY_LABELS: Record<WidgetCapability, string> = {
  'active-document': 'active document',
  'file-tree': 'file tree',
  'tag-queries': 'tags',
  'task-queries': 'tasks',
  search: 'search',
  commands: 'commands',
};
