/**
 * The Review tab's pure patch helpers (E13-7): a unified patch as numbered
 * rows, laid over the whole file, plus the viewed-mark key and the words
 * the comment affordances use. The same behaviour as the phone client's
 * `patchRowsOf` / `wholeFileRowsOf` (`libs/mission-ui`, E11-2) -- the lib
 * is Angular-bound and the plugin renderer may not import it, so this is
 * the plugin-side port; both have specs pinning the same cases.
 */

export type PatchRowKind = 'add' | 'del' | 'context' | 'meta' | 'hunk';

export interface PatchRow {
  readonly kind: PatchRowKind;
  /** The old file's line number; null when the row carries none. */
  readonly oldNo: number | null;
  /** The new file's line number; null when the row carries none. Comments attach to these. */
  readonly newNo: number | null;
  readonly text: string;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const isMeta = (line: string): boolean =>
  line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('\\');

/**
 * Hunk headers seed the counters, `+` / `-` / context rows spend them, the
 * fence lines (`diff`, `index`, `---`, `+++`, `\ No newline`) ride as meta
 * without numbers. A patch that skips its hunk header still renders; the
 * numbers then start at 1. A binary file's empty patch has no rows.
 */
export function patchRowsOf(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  if (patch === '') {
    return rows;
  }
  let oldNo = 1;
  let newNo = 1;
  let inHunk = false;
  const lines = patch.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const hunk = HUNK_HEAD.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldNo = parseInt(hunk[1]!, 10);
      newNo = parseInt(hunk[2]!, 10);
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
    } else if (isMeta(line) || (!inHunk && /^(index |new file mode|deleted file mode|old mode|new mode|similarity |rename |copy |Binary files |GIT binary patch)/.test(line))) {
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else {
      rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }
  return rows;
}

/** Lines added and removed by a patch (what the file chip shows); zero for a binary file. */
export function countsOf(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of patchRowsOf(patch)) {
    if (row.kind === 'add') {
      added++;
    } else if (row.kind === 'del') {
      removed++;
    }
  }
  return { added, removed };
}

/**
 * The patch laid over the whole file: every line of the new file in order,
 * the patch's added / removed rows in place, the lines between and around
 * the hunks as context. Hunk headers drop out (the file is continuous).
 */
export function wholeFileRowsOf(patch: string, content: string): PatchRow[] {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const out: PatchRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  const fillTo = (until: number): void => {
    while (newNo < until && newNo <= lines.length) {
      out.push({ kind: 'context', oldNo: oldNo++, newNo, text: lines[newNo - 1]! });
      newNo++;
    }
  };
  for (const row of patchRowsOf(patch)) {
    if (row.kind === 'hunk') {
      const head = HUNK_HEAD.exec(row.text);
      if (head !== null) {
        const newStart = parseInt(head[2]!, 10);
        fillTo(newStart);
        oldNo = Math.max(parseInt(head[1]!, 10), 1);
        newNo = Math.max(newStart, 1);
      }
      continue;
    }
    if (row.kind === 'meta') {
      continue;
    }
    out.push(row);
    if (row.oldNo !== null) {
      oldNo = row.oldNo + 1;
    }
    if (row.newNo !== null) {
      newNo = row.newNo + 1;
    }
  }
  fillTo(lines.length + 1);
  return out;
}

/**
 * The key a "viewed" mark is stored under: the path plus a short hash of
 * its patch, so a file that changed after the owner looked at it reads as
 * not viewed again.
 */
export function viewedKeyOf(path: string, patch: string): string {
  let hash = 5381;
  for (let i = 0; i < patch.length; i++) {
    hash = ((hash << 5) + hash + patch.charCodeAt(i)) | 0;
  }
  return `${path}#${(hash >>> 0).toString(36)}`;
}

/** `Line 27` or `Lines 30–33`. */
export function commentLabelOf(comment: { line: number; endLine: number | null }): string {
  return comment.endLine === null ? `Line ${comment.line}` : `Lines ${comment.line}–${comment.endLine}`;
}

/** The send-back button: with comments it names how many. */
export function sendBackLabelOf(count: number): string {
  return count === 0 ? 'Send back…' : `Send back with ${count} ${count === 1 ? 'comment' : 'comments'}`;
}
