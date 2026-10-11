import { Type } from '@angular/core';

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
  /**
   * True for a page whose edits reach disk as they are made (plugin pages,
   * ADR-0044 rule 3) -- the screen then offers no Save / Discard for it.
   */
  savesImmediately?: boolean;
}
