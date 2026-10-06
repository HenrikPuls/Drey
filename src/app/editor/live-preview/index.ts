import { Extension } from '@codemirror/state';
import { livePreviewBlocks, LivePreviewConfig } from './block-render';
import { livePreviewConceal } from './conceal';
import { livePreviewTheme } from './theme';
import { tableEnter } from './table-enter';

export type { LivePreviewConfig } from './block-render';

export interface LivePreviewOptions {
  /**
   * `false` renders the document fully, always: the selection is ignored,
   * so no construct ever flips back to its raw Markdown source. Used by
   * the surface's read-only view mode.
   */
  revealSelection?: boolean;
}

/**
 * The Live Preview mode (ADR-0009): three cooperating extensions over the
 * one CodeMirror instance. Loaded/unloaded through a `Compartment` when the
 * `⋯` menu switches between Live Preview and Source.
 */
export function livePreview(config: LivePreviewConfig, opts: LivePreviewOptions = {}): Extension {
  return [
    livePreviewConceal(opts),
    livePreviewBlocks(config, opts),
    // The row-insertion Enter is an editing affordance; the read-only view
    // mode (`revealSelection: false`) keeps the plain newline.
    opts.revealSelection === false ? [] : tableEnter(),
    livePreviewTheme,
  ];
}
