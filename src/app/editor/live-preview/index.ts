import { Extension } from '@codemirror/state';
import { livePreviewBlocks, LivePreviewConfig } from './block-render';
import { livePreviewConceal } from './conceal';
import { livePreviewTheme } from './theme';

export type { LivePreviewConfig } from './block-render';

/**
 * The Live Preview mode (ADR-0009): three cooperating extensions over the
 * one CodeMirror instance. Loaded/unloaded through a `Compartment` when the
 * `⋯` menu switches between Live Preview and Source.
 */
export function livePreview(config: LivePreviewConfig): Extension {
  return [livePreviewConceal, livePreviewBlocks(config), livePreviewTheme];
}
