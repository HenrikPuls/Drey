import { stringify } from 'yaml';

import { DEFAULT_RANK, phaseDirectoryName } from '../contracts/tickets';
import { flatList, flatText, parseFlatDocument } from '../store/flat-frontmatter';
import { toDisplayId } from '../store/ids';
import { ARCHIVED_LABEL } from '../store/legacy-bridge';
import { BOOLEAN_KEYS, LIST_KEYS, NUMERIC_KEYS } from './convert';

/**
 * The REVERSE converter (E14-3, migration-plan §5 "rollback" level 3):
 * a dricket ticket document -> the legacy file text. It is the exit door of
 * the migration -- if the cut-over has to be undone, this writes the board
 * back into the legacy layout of a FRESH clone of the old repo.
 *
 * Nothing the legacy format cannot express is dropped silently: `lost`
 * names it per ticket, and comments (legacy has no comment store) are
 * appended to the ticket's `## Log` as one line each.
 */

export interface DricketComment {
  /** ISO stamp (second precision is used). */
  readonly at: string;
  readonly author: string;
  readonly text: string;
}

export interface ReverseInput {
  /** The whole `ticket.md` as `dk show --json` returns it (`content`). */
  readonly content: string;
  readonly comments?: readonly DricketComment[];
}

export interface ReverseOptions {
  /** The pipeline's phase ids in board order -- numbers the folders (`10-inbox` ...). */
  readonly phases: readonly string[];
  /** Folder names as the legacy vault has them (`build` -> `50-build`); default `NN-phase` by position. */
  readonly phaseDirs?: Readonly<Record<string, string>>;
}

export interface ReversedTicket {
  /** Display id. */
  readonly id: string;
  readonly phase: string;
  /** Path relative to the vault root: `tickets/<NN-phase>/T-nnnn.md`. */
  readonly relPath: string;
  readonly text: string;
  /** What the legacy format cannot hold, per ticket (reported, never silent). */
  readonly lost: readonly string[];
}

/** Keys dk owns that carry no legacy meaning (or are audit stamps of the migration itself). */
const AUDIT_KEYS: ReadonlySet<string> = new Set(['x-legacy-id', 'x-legacy-phase', 'x-legacy-priority', 'x-legacy-blocked-by', 'x-legacy-parent', 'x-legacy-commit', 'x-created-at', 'x-created-by']);

export function reverseTicket(input: ReverseInput, options: ReverseOptions): ReversedTicket {
  const doc = parseFlatDocument(input.content);
  const f = doc.fields;
  const id = toDisplayId(f['id'] ?? '');
  const stage = f['stage'] ?? '';
  const lost: string[] = [];

  const header: Record<string, unknown> = {};
  header['id'] = id;
  header['title'] = f['title'] ?? id;
  const repos = flatList(f['repos']);
  if (repos.length > 0) {
    header['repo'] = repos[0];
    if (repos.length > 1) {
      header['repos'] = repos;
    }
  }
  header['priority'] = flatText(f['priority']) ?? 'normal';
  const ext = Object.entries(f).filter(([k]) => k.startsWith('x-'));
  const rank = ext.find(([k]) => k === 'x-rank')?.[1];
  header['rank'] = rank !== undefined && /^-?\d+$/.test(rank) ? Number(rank) : DEFAULT_RANK;
  header['branch'] = flatText(f['branch']) ?? `t/${id}`;
  const depends = [...new Set([...flatList(f['depends']).map(toDisplayId), ...flatList(f['x-legacy-blocked-by'])])];
  if (depends.length > 0) {
    header['blocked-by'] = depends;
  }
  const parent = flatText(f['parent']);
  const legacyParent = flatText(f['x-legacy-parent']);
  if (parent !== null) {
    header['parent'] = toDisplayId(parent);
  } else if (legacyParent !== null) {
    header['parent'] = legacyParent;
  }
  for (const [key, value] of ext) {
    if (key.startsWith('x-entered-')) {
      header[key.slice(2)] = value;
    }
  }
  for (const [key, value] of ext) {
    if (key === 'x-rank' || key.startsWith('x-entered-') || AUDIT_KEYS.has(key)) {
      continue;
    }
    const name = key.slice(2);
    header[name] = typedValue(name, value);
  }
  const owner = flatText(f['owner']);
  if (owner !== null) {
    header['claimed-by'] = owner;
    const at = flatText(f['claimed_at']);
    if (at !== null) {
      header['claimed-at'] = at;
    }
  }
  const archived = flatList(f['labels']).includes(ARCHIVED_LABEL);
  const otherLabels = flatList(f['labels']).filter((l) => l !== ARCHIVED_LABEL);
  if (otherLabels.length > 0) {
    lost.push(`labels (${otherLabels.join(', ')}) -- the legacy format has none`);
  }
  if (flatList(f['touches']).length > 0) {
    lost.push('touches -- the legacy format has none');
  }
  if (owner !== null) {
    lost.push(`lease and epoch of the claim by ${owner} -- the legacy format has no leases`);
  }

  let body = doc.body;
  const comments = input.comments ?? [];
  if (comments.length > 0) {
    body = appendCommentsToLog(body, comments);
    lost.push(`${comments.length} comment(s) written into the Log as one line each`);
  }

  const phaseIndex = options.phases.indexOf(stage);
  const dir = archived ? 'archive' : options.phaseDirs?.[stage] ?? (phaseIndex >= 0 ? phaseDirectoryName(phaseIndex + 1, stage) : stage);
  if (phaseIndex < 0 && !archived) {
    lost.push(`stage "${stage}" is not a pipeline phase; the folder is named after it`);
  }
  const yamlText = stringify(header, { lineWidth: 0 });
  return { id, phase: stage, relPath: `tickets/${dir}/${id}.md`, text: `---\n${yamlText}---\n${body}`, lost };
}

function typedValue(name: string, value: string): unknown {
  if (NUMERIC_KEYS.has(name) && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (BOOLEAN_KEYS.has(name) && (value === 'true' || value === 'false')) {
    return value === 'true';
  }
  if (LIST_KEYS.has(name)) {
    const parts = (name === 'chain' ? value.split(';') : value.split(',')).map((s) => s.trim()).filter((s) => s !== '');
    return parts;
  }
  return value;
}

function appendCommentsToLog(body: string, comments: readonly DricketComment[]): string {
  const lines = comments.map((c) => {
    const stamp = c.at.replace(/\.\d+Z$/, 'Z');
    const first = c.text.replace(/\s+/g, ' ').trim();
    return `- '${stamp}' ${c.author} — comment: ${first}`;
  });
  const trimmed = body.replace(/\s+$/, '');
  const hasLog = /^## Log\s*$/m.test(trimmed);
  return `${trimmed}${hasLog ? '' : '\n\n## Log\n'}\n${lines.join('\n')}\n`;
}
