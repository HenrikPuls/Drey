/**
 * `src/app/widgets` — the internal widget model (ADR-0034).
 *
 * The dock panels are "widgets": a data-driven registry
 * (`WIDGETS` / `WidgetDescriptor`, in `../dock` so it can name the panel
 * components) plus this module's `WidgetContext` — the one typed surface a
 * widget uses to read the active document, the vault file tree and the
 * standard queries (tags, tasks, search). No runtime / third-party plugin
 * loading, no sandbox.
 *
 * This barrel is the module's only public surface — import from
 * `../widgets`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export { WidgetContext, type WidgetSelection } from './widget-context';
export {
  type WidgetCapability,
  WIDGET_CAPABILITY_LABELS,
} from './widget-capability';
