import { describe, expect, it } from 'vitest';
import { phaseWithoutPoolKeys, type PipelinePhase } from '../shared/tickets';
import { TAG_AUTO_PALETTE } from '../../../shared/tag-style';
import { phaseColorOf } from './phase-colors';

/** T-0084: explicit `color:` wins, else the tag palette by board position. */

const phase = (color: string | null): PipelinePhase =>
  phaseWithoutPoolKeys({ id: 'build', title: 'Build', wip: null, claim: false, handover: 'agent build-default', color });

describe('phaseColorOf', () => {
  it('an explicit color wins over the palette', () => {
    expect(phaseColorOf(phase('#c96442'), 0)).toBe('#c96442');
    expect(phaseColorOf(phase('#000000'), 3)).toBe('#000000');
  });

  it('without one the palette colours by board position', () => {
    expect(phaseColorOf(phase(null), 0)).toBe(TAG_AUTO_PALETTE[0]);
    expect(phaseColorOf(phase(null), 1)).toBe(TAG_AUTO_PALETTE[1]);
    // An explicit colour on one phase does not shift the others' defaults.
    expect(phaseColorOf(phase(null), 0)).toBe(TAG_AUTO_PALETTE[0]);
  });

  it('wraps past the palette length and never goes negative', () => {
    expect(phaseColorOf(phase(null), TAG_AUTO_PALETTE.length)).toBe(TAG_AUTO_PALETTE[0]);
    expect(phaseColorOf(phase(null), TAG_AUTO_PALETTE.length + 2)).toBe(TAG_AUTO_PALETTE[2]);
    expect(phaseColorOf(phase(null), -1)).toBe(TAG_AUTO_PALETTE[TAG_AUTO_PALETTE.length - 1]);
  });
});
