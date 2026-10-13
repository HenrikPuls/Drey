/**
 * Exact text replacement as a model asks for it (ADR-0071): a list of
 * `{ oldText, newText }` edits applied to one text, all or none. Pure.
 *
 * An edit's `oldText` must occur EXACTLY ONCE (unless it says
 * `replaceAll`) — that is what makes the format safe to apply without a
 * human reading a diff first: text that is not there, or that is there
 * twice, is refused instead of guessed at. Edits apply in order, so a
 * later one may build on an earlier one's replacement.
 *
 * The refusals are written for the model: each names the edit and what
 * to change about it.
 */

export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type TextEditResult =
  | {
      ok: true;
      text: string;
      /** How many places were replaced, over all edits. */
      replacements: number;
      /** The 1-based line of every replacement, in the text it was found in, ascending. */
      lines: number[];
    }
  | { ok: false; error: string };

const QUOTE_LIMIT = 80;

function quote(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return JSON.stringify(line.length > QUOTE_LIMIT ? `${line.slice(0, QUOTE_LIMIT)}…` : line);
}

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

function occurrences(text: string, find: string): number[] {
  const at: number[] = [];
  let index = text.indexOf(find);
  while (index !== -1) {
    at.push(index);
    index = text.indexOf(find, index + find.length);
  }
  return at;
}

/**
 * Why `find` is not in `text`, as far as that can be told cheaply: the
 * usual cause is whitespace (indentation, a trailing space, a blank line)
 * or line numbers copied from a numbered listing.
 */
function missHint(text: string, find: string): string {
  if (/^\s*\d+[:|]\s/m.test(find) && !/^\s*\d+[:|]\s/m.test(text)) {
    return ' It looks like it carries the line numbers of a listing — send the text without them.';
  }
  const squeeze = (value: string): string => value.replace(/\s+/g, ' ').trim();
  if (squeeze(find) !== '' && squeeze(text).includes(squeeze(find))) {
    return ' The words are there, but spaces or line breaks differ — copy the text exactly as the file has it.';
  }
  return ' Read the file again and copy the text exactly; it may have changed.';
}

/** Applies `edits` to `text`, all or none. Both are expected with `\n` line ends. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): TextEditResult {
  if (edits.length === 0) {
    return { ok: false, error: 'Error: no edits were given — pass at least one.' };
  }
  let work = text;
  let replacements = 0;
  const lines: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const label = edits.length === 1 ? 'The edit' : `Edit ${i + 1}`;
    if (edit.oldText === '') {
      return {
        ok: false,
        error: `Error: ${label} has an empty old_text — nothing was changed. Give the text to replace; to add to the end of a file use vault_write with mode "append".`,
      };
    }
    if (edit.oldText === edit.newText) {
      return {
        ok: false,
        error: `Error: ${label} replaces ${quote(edit.oldText)} with the same text — nothing was changed.`,
      };
    }
    const found = occurrences(work, edit.oldText);
    if (found.length === 0) {
      return {
        ok: false,
        error: `Error: ${label}: old_text ${quote(edit.oldText)} was not found — nothing was changed.${missHint(work, edit.oldText)}`,
      };
    }
    if (found.length > 1 && edit.replaceAll !== true) {
      return {
        ok: false,
        error: `Error: ${label}: old_text ${quote(edit.oldText)} occurs ${found.length} times (lines ${found
          .map((at) => lineOfIndex(work, at))
          .join(', ')}) — nothing was changed. Add surrounding lines so it matches once, or set replace_all to change every occurrence.`,
      };
    }
    for (const at of found) {
      lines.push(lineOfIndex(work, at));
    }
    replacements += found.length;
    work = work.split(edit.oldText).join(edit.newText);
  }
  return { ok: true, text: work, replacements, lines: [...lines].sort((a, b) => a - b) };
}
