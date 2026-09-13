import {
  composeInsertedBelow,
  stripOuterFence,
} from '../../../plugins/ocr/shared/ocr';
import { OCR_SYSTEM, OCR_USER } from '../../../plugins/ocr/shared/ocr-prompt';

/**
 * Specs for the ocr plugin's reply cleanup and insertion composition
 * (`plugins/ocr/shared/ocr.ts` + `ocr-prompt.ts`): the fence-tolerant
 * transcription cleanup, the below-the-image splice with its blank-line
 * separator, and the English prompt contract (verbatim, no fences,
 * [illegible] markers). The Angular runner ignores `plugins/**`, so plugin
 * specs live here.
 */

describe('stripOuterFence', () => {
  it('leaves plain text untouched', () => {
    expect(stripOuterFence('Einkaufsliste\n- Milch')).toBe('Einkaufsliste\n- Milch');
  });

  it('strips ONE fence that wraps the whole reply, with or without a language tag', () => {
    expect(stripOuterFence('```\nHallo\nWelt\n```')).toBe('Hallo\nWelt');
    expect(stripOuterFence('```markdown\nHallo\n```')).toBe('Hallo');
    expect(stripOuterFence('  ```\nHallo\n```\n')).toBe('Hallo'); // padded fence still whole-reply
  });

  it('keeps fences that do not span the whole reply', () => {
    expect(stripOuterFence('Intro:\n```\ncode\n```\nEnde')).toBe('Intro:\n```\ncode\n```\nEnde');
  });
});

describe('composeInsertedBelow', () => {
  it('splices the transcription after the image line, blank-line separated', () => {
    const before = '# Note\n\n![alt](pic.png)\n\nNext section';
    const after = composeInsertedBelow(before, 3, 'Hallo Welt');

    expect(after).toBe('# Note\n\n![alt](pic.png)\n\nHallo Welt\n\nNext section');
  });

  it('handles a multi-line transcription and the document end', () => {
    expect(composeInsertedBelow('![a](x.png)', 1, 'eins\nzwei')).toBe(
      '![a](x.png)\n\neins\nzwei',
    );
    // A trailing newline is an (empty) final line — it survives the splice.
    expect(composeInsertedBelow('![a](x.png)\n', 1, 'text')).toBe('![a](x.png)\n\ntext\n');
  });

  it('preserves the line following the insertion point', () => {
    const after = composeInsertedBelow('l1\nl2\nl3', 2, 'T');
    expect(after.split('\n')).toEqual(['l1', 'l2', '', 'T', 'l3']);
  });
});

describe('OCR prompt contract', () => {
  it('demands a verbatim, fence-free transcription with [illegible] markers', () => {
    expect(OCR_SYSTEM).toMatch(/verbatim/i);
    expect(OCR_SYSTEM).toMatch(/Do not wrap the transcription in a code fence/);
    expect(OCR_SYSTEM).toMatch(/\[illegible\]/);
    expect(OCR_SYSTEM).toMatch(/line breaks/);
  });

  it('sends exactly one user turn (the image rides attachments)', () => {
    expect(OCR_USER).toBe('Transcribe all text visible in this image.');
  });
});
