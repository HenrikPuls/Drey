/**
 * Appends a routed entry into a master document's `## History` section
 * (milestone 6b). Pure -- `electron/note-manager.ts` does the file IO.
 *
 * Idempotent: each appended entry carries an HTML-comment marker
 * (`<!-- drey:src <path>@<date> <time> -->`) on its heading line, so
 * re-saving the source note never appends a second copy. The section is
 * created if the master has none. Entries land at the end of the section
 * (not date-sorted -- see docs/11); an HTML comment does not render in the
 * preview, so the marker is invisible.
 */

export interface HistoryAppend {
  /** `YYYY-MM-DD` of the entry. */
  date: string;
  /** `HH:mm` of the entry. */
  time: string;
  /** Vault-relative path of the note the entry came from. */
  sourcePath: string;
  /** The entry's body text (no heading). */
  entryText: string;
}

const HISTORY_HEADING = /^## History[ \t]*$/m;
/** Next `## ` heading (two hashes + space) -- `### ` sub-headings do not end the section. */
const NEXT_H2 = /^## /m;

export function historyMarker(sourcePath: string, date: string, time: string): string {
  return `<!-- drey:src ${sourcePath}@${date} ${time} -->`;
}

export function appendHistoryEntry(
  masterText: string,
  append: HistoryAppend,
): { text: string; appended: boolean } {
  const body = append.entryText.trim();
  if (body === '') {
    return { text: masterText, appended: false };
  }

  const marker = historyMarker(append.sourcePath, append.date, append.time);
  if (masterText.includes(marker)) {
    return { text: masterText, appended: false };
  }

  const block = `### ${append.date} ${append.time} ${marker}\n${body}`;

  const heading = HISTORY_HEADING.exec(masterText);
  if (!heading) {
    const base = masterText.replace(/\s+$/, '');
    const lead = base === '' ? '' : `${base}\n\n`;
    return { text: `${lead}## History\n\n${block}\n`, appended: true };
  }

  const sectionStart = heading.index + heading[0].length;
  const next = NEXT_H2.exec(masterText.slice(sectionStart));
  const sectionEnd = next ? sectionStart + next.index : masterText.length;

  const before = masterText.slice(0, sectionEnd).replace(/\s+$/, '');
  const after = masterText.slice(sectionEnd).replace(/^\s+/, '');
  return {
    text: after ? `${before}\n\n${block}\n\n${after}` : `${before}\n\n${block}\n`,
    appended: true,
  };
}
