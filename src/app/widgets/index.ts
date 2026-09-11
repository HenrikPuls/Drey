/**
 * `src/app/widgets` — the descriptive widget-capability labels.
 *
 * Since ADR-0044 the dock panels are registered at runtime (base widgets
 * via `registerCoreWidgets()`, plugin panels via the plugin host); the
 * registry (`WidgetDescriptor`) lives in `../dock`. This module keeps the
 * `WidgetCapability` vocabulary a descriptor declares about its read
 * surfaces — descriptive, surfaced in Settings → Panels & plugins.
 *
 * This barrel is the module's only public surface — import from
 * `../widgets`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export {
  type WidgetCapability,
  WIDGET_CAPABILITY_LABELS,
} from './widget-capability';
