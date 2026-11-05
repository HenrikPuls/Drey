import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

import { splitFrontmatter } from '../../../../shared/frontmatter';
import { stripPhasePrefix, TICKET_ID_PATTERN } from '../contracts/tickets';

/**
 * Read-only reader of a LEGACY tickets vault (E14-3, migration-plan §3): the
 * `tickets/<NN-phase>/T-nnnn.md` files of the file store, taken as raw
 * material for the converter. Nothing here writes; it spawns no process (`x-legacy-commit` is not carried:
 * the history is cut, the old repo keeps it under the `pre-dricket` tag).
 *
 * Unlike `core/ticket-files.parseTicketFile` this keeps the header as the raw
 * YAML object (the converter must see every key, including the ones Drey does
 * not model) and never normalises.
 */

export interface LegacyTicket {
  /** Display id `T-0063`, from the file name. */
  readonly id: string;
  /** Phase id with the `NN-` prefix stripped; `archive` for `tickets/archive/`. */
  readonly phase: string;
  /** Path relative to the vault root, `/`-separated. */
  readonly relPath: string;
  /** The header as parsed YAML (key order kept). */
  readonly header: Readonly<Record<string, unknown>>;
  /** Everything after the closing fence, verbatim. */
  readonly body: string;
  /** The whole file, verbatim. */
  readonly text: string;
  /** Problems found while reading (never thrown). */
  readonly issues: readonly string[];
}

export interface LegacyVault {
  readonly root: string;
  readonly tickets: readonly LegacyTicket[];
  /** Files under `tickets/` that look like tickets but could not be read as one. */
  readonly unreadable: readonly { readonly relPath: string; readonly reason: string }[];
}

const ARCHIVE_PHASE = 'archive';

/** Reads every ticket file of the vault, phase folders and `archive/`. */
export function readLegacyVault(root: string): LegacyVault {
  const ticketsDir = path.join(root, 'tickets');
  if (!existsSync(ticketsDir) || !statSync(ticketsDir).isDirectory()) {
    throw new Error(`${root} is not a tickets vault (no tickets/ folder)`);
  }
  const tickets: LegacyTicket[] = [];
  const unreadable: { relPath: string; reason: string }[] = [];
  for (const entry of readdirSync(ticketsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_meta' || entry.name === 'attachments' || entry.name === 'videos') {
      continue;
    }
    const phase = entry.name === ARCHIVE_PHASE ? ARCHIVE_PHASE : stripPhasePrefix(entry.name);
    for (const file of readdirSync(path.join(ticketsDir, entry.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.md')) {
        continue;
      }
      const relPath = `tickets/${entry.name}/${file.name}`;
      const stem = file.name.slice(0, -3);
      if (!TICKET_ID_PATTERN.test(stem)) {
        unreadable.push({ relPath, reason: 'file name is not a ticket id (T-nnnn)' });
        continue;
      }
      const text = readFileSync(path.join(ticketsDir, entry.name, file.name), 'utf8');
      const parsed = parseLegacyTicket(text, relPath, stem, phase);
      if ('reason' in parsed) {
        unreadable.push({ relPath, reason: parsed.reason });
      } else {
        tickets.push(parsed);
      }
    }
  }
  tickets.sort((a, b) => ticketNumber(a.id) - ticketNumber(b.id));
  return { root, tickets, unreadable };
}

/** Parses one legacy file; a reason string when it cannot be a ticket at all. */
export function parseLegacyTicket(text: string, relPath: string, stem: string, phase: string): LegacyTicket | { reason: string } {
  const { yamlText, body, hadFence } = splitFrontmatter(normaliseNewlines(text));
  if (!hadFence || yamlText === null) {
    return { reason: 'no front matter fence' };
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return { reason: `front matter does not parse: ${doc.errors[0]!.message}` };
  }
  const obj = doc.toJS() as unknown;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { reason: 'front matter is not a mapping' };
  }
  const header = obj as Record<string, unknown>;
  const issues: string[] = [];
  const id = typeof header['id'] === 'string' ? header['id'] : String(header['id'] ?? '');
  if (id !== stem) {
    issues.push(`id "${id}" does not match the file name ${stem}; the file name wins`);
  }
  return { id: stem, phase, relPath, header, body, text, issues };
}

/** CRLF -> LF (dricket normalises on write, so the converter does the same up front) and no byte order mark: an editor on Windows adds one, and it hides the opening fence. */
export function normaliseNewlines(text: string): string {
  return (text.startsWith('\uFEFF') ? text.slice(1) : text).split('\r\n').join('\n');
}

export function ticketNumber(id: string): number {
  return Number(/^T-(\d+)$/.exec(id)?.[1] ?? Number.NaN);
}
