/**
 * The OCR prompt pair (ADR-0050). English like every other prompt sent to
 * the model — the transcription itself comes out in the image's language
 * because the contract is verbatim.
 *
 * This lives in the PLUGIN, not `shared/app-config.ts`: unlike the Autotag
 * prompt there is no user-editable template for it (v1), and the plugin
 * owns its whole feature.
 */

/** System prompt: the verbatim-transcription contract. */
export const OCR_SYSTEM = [
  'You are an OCR assistant. Transcribe ALL text visible in the image.',
  'Rules:',
  '- Transcribe verbatim. Do not translate, correct, summarize, or comment.',
  '- Preserve the original line breaks, list markers, and simple structure.',
  '- Output plain Markdown only. Do not wrap the transcription in a code fence.',
  '- Mark words you cannot read as [illegible]. If the image shows no text, output [no text].',
].join('\n');

/** User turn — the image itself rides `options.attachments`. */
export const OCR_USER = 'Transcribe all text visible in this image.';
