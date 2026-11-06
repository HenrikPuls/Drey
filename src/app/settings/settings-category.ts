import { Type } from '@angular/core';
import type { SettingsSearchEntry, SettingsSection } from './settings-model';

/**
 * One entry in the Settings screen's category list. The screen renders the
 * left-hand nav and the detail pane from an array of these rather than a
 * hard-coded `@switch`, so a feature can contribute its own category
 * without the screen knowing about it up front.
 *
 * Today a descriptor is just identity + which component to show. When the
 * feature-module cut lands (`electron/tags/`, `shared/tags/`, …) the same
 * descriptor is where a module will also hand over its config-slice
 * default and `normalize` function — kept here as the single registration
 * point, see the plan's "Feature-owns-settings".
 */
export interface SettingsCategory {
  /** Stable id, used for the selected-category signal and deep links. */
  id: string;
  /** Left-nav label. */
  label: string;
  /** Left-nav sub-label. */
  hint: string;
  /** The pane component shown on the right when this category is selected. */
  component: Type<unknown>;
  /** One sentence under the page title (searchable). */
  description?: string;
  /**
   * Parts of the page, listed as expandable entries under the category.
   * Each is the page's element carrying `data-settings-section="<id>"`.
   */
  sections?: readonly SettingsSection[];
  /** The page's searchable settings (label, description, key). */
  entries?: readonly SettingsSearchEntry[];
}
