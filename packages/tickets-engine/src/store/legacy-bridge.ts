import { parse } from 'yaml';
import { toDricketId } from './ids';

/**
 * The write half of the board bridge (E14-4b, ADR-0090). The board reads a
 * dricket record folded into the LEGACY ticket shape (`recordToBoardFile`), and
 * every board mutation (refine, header edits, parts, flow, moves) is still a
 * pure text patch of that legacy file. This module turns the patched legacy
 * text back into the dricket document that `dk put` takes — the inverse of
 * `recordToBoardFile`, no more.
 *
 * It decides nothing dricket decides: identity, claim, lease, epoch and `rev`
 * fields stay exactly as the CURRENT document (the one `dk` produced) has them,
 * `dk put` validates the result. Pure: no IO, no `dk`.
 */

const FENCE = '---';

/** Legacy keys that ride in an `x-` extension field (same list as `store-board`). */
const EXTENSION_KEYS = ['worker', 'persona', 'track', 'form', 'proof', 'awaiting'] as const;

/** The label a closed-and-archived ticket carries (the archive is a label under dricket, migration plan §3). */
export const ARCHIVED_LABEL = 'archived';

/** The label of a cancelled import placeholder that keeps a legacy number free (E14-3); it is not a ticket of the board. */
export const PLACEHOLDER_LABEL = 'placeholder';

export interface BridgeOptions {
  /** The stage the document gets (variant A: the pipeline phase id). */
  readonly stage: string;
  /** `true` adds the `archived` label, `false` removes it, absent leaves the labels. */
  readonly archived?: boolean;
}

interface Split {
  readonly header: string;
  readonly body: string;
}

function split(text: string): Split {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== FENCE) {
    throw new Error('not a ticket document: no front matter fence');
  }
  const close = lines.indexOf(FENCE, 1);
  if (close < 0) {
    throw new Error('not a ticket document: front matter is not closed');
  }
  return { header: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n') };
}

/** One flat value: a single line, no fence-breaking newline. */
function flat(value: unknown): string {
  return String(value).replace(/\s*\n\s*/g, ' ').trim();
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => flat(v)).filter((v) => v !== '');
  }
  return typeof value === 'string' && value.trim() !== '' ? [flat(value)] : [];
}

/** The dricket header values a legacy header implies. `null` = the key must not stay in the document. */
function fieldsOf(legacy: Record<string, unknown>, stage: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  out.set('stage', stage);
  if (typeof legacy['title'] === 'string') {
    out.set('title', flat(legacy['title']));
  }
  if (typeof legacy['priority'] === 'string') {
    out.set('priority', flat(legacy['priority']));
  }
  const repos = Array.isArray(legacy['repos']) ? listOf(legacy['repos']) : listOf(legacy['repo']);
  out.set('repos', repos.join(', '));
  out.set('depends', listOf(legacy['blocked-by']).map((id) => toDricketId(id) ?? id.toLowerCase()).join(', '));
  const parent = typeof legacy['parent'] === 'string' ? legacy['parent'] : '';
  out.set('parent', parent === '' ? '' : (toDricketId(parent) ?? parent.toLowerCase()));
  const rank = legacy['rank'];
  out.set('x-rank', rank === undefined || rank === null ? null : flat(rank));
  for (const key of EXTENSION_KEYS) {
    const value = legacy[key];
    out.set(`x-${key}`, typeof value === 'string' && value.trim() !== '' ? flat(value) : null);
  }
  out.set('x-interactive', legacy['interactive'] === true ? 'true' : null);
  const chain = listOf(legacy['chain']);
  out.set('x-chain', chain.length > 0 ? chain.join(';') : null);
  const references = listOf(legacy['references']);
  out.set('x-references', references.length > 0 ? references.join(',') : null);
  for (const [key, value] of Object.entries(legacy)) {
    if (/^entered-[a-z][a-z0-9-]*$/.test(key)) {
      out.set(`x-${key}`, value === null || value === undefined ? null : flat(value));
    }
  }
  return out;
}

/** Keys the legacy header owns: absent there = gone from the document. */
function isManagedExtension(key: string): boolean {
  return (
    key === 'x-rank' ||
    key === 'x-interactive' ||
    key === 'x-chain' ||
    key === 'x-references' ||
    EXTENSION_KEYS.some((k) => key === `x-${k}`) ||
    /^x-entered-/.test(key)
  );
}

/**
 * The dricket document for a patched legacy ticket text, built on `current` (the
 * document as stored now). Header lines keep their order; managed fields are
 * replaced, dropped or appended; the body is the legacy body byte for byte.
 */
export function legacyToDricketDocument(current: string, legacyText: string, options: BridgeOptions): string {
  const now = split(current);
  const legacy = split(legacyText);
  const parsed: unknown = parse(legacy.header);
  const header = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const wanted = fieldsOf(header, options.stage);
  const written = new Set<string>();
  const lines: string[] = [];
  for (const line of now.header.split('\n')) {
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : '';
    if (key === 'labels' && options.archived !== undefined) {
      const labels = line
        .slice(colon + 1)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== ARCHIVED_LABEL);
      if (options.archived) {
        labels.push(ARCHIVED_LABEL);
      }
      lines.push(`labels: ${labels.join(', ')}`);
      written.add('labels');
      continue;
    }
    if (key === 'x-phase') {
      // Variant B documents pin the phase beside the stage: keep the pin in step.
      lines.push(`x-phase: ${options.stage}`);
      written.add(key);
      continue;
    }
    if (wanted.has(key)) {
      const value = wanted.get(key)!;
      written.add(key);
      if (value !== null) {
        lines.push(`${key}: ${value}`);
      }
      continue;
    }
    if (isManagedExtension(key)) {
      continue;
    }
    lines.push(line);
  }
  for (const [key, value] of wanted) {
    if (!written.has(key) && value !== null && (value !== '' || !key.startsWith('x-'))) {
      if (value === '' && !['repos', 'depends', 'parent'].includes(key)) {
        continue;
      }
      lines.push(`${key}: ${value}`);
    }
  }
  if (options.archived === true && !written.has('labels')) {
    lines.push(`labels: ${ARCHIVED_LABEL}`);
  }
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n${legacy.body}`;
}
