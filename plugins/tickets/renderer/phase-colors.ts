/**
 * The Work panel's phase chip colours (T-0084): an explicit `color:` in
 * pipeline.md wins; without one a curated default palette colours by the
 * column's board position, so adjacent phases get distinct hues — one
 * colour family app-wide, shared with the tag auto colours.
 */
import { TAG_AUTO_PALETTE } from '../../../shared/tag-style';
import type { PipelinePhase } from '../shared/tickets';

/**
 * The colour of a phase's chip. `boardPosition` is the column's index
 * among the configured columns (unknown directories count after them).
 */
export function phaseColorOf(phase: PipelinePhase, boardPosition: number): string {
  return phase.color ?? TAG_AUTO_PALETTE[((boardPosition % TAG_AUTO_PALETTE.length) + TAG_AUTO_PALETTE.length) % TAG_AUTO_PALETTE.length]!;
}
