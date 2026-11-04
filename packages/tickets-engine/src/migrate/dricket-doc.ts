import type { TargetTicket } from './convert';

/**
 * Fills a dricket ticket document with a converted legacy ticket (E14-3).
 *
 * This is NOT a dricket writer: the document it patches is always one that
 * `dk` produced (`dk show` after `dk add`) -- identity, claim and revision
 * fields stay exactly as dk wrote them, `dk put` validates the result. It
 * only sets the header keys `dk add` has no flag for (stage, branch, repos,
 * `x-` fields) and swaps the body for the legacy one byte for byte.
 * `stubDocument` builds a dk-shaped document for the dry run's preview.
 */

const FENCE = '---';

/** Header keys of a dricket ticket in dk's canonical order (observed on v0.6.0). */
const CANONICAL_ORDER = [
  'id',
  'created_at',
  'created_by',
  'schema_version',
  'title',
  'stage',
  'owner',
  'kind',
  'size',
  'claimed_at',
  'lease_until',
  'epoch',
  'rev',
  'extensions',
  'priority',
  'labels',
  'depends',
  'parent',
  'touches',
  'branch',
  'repos',
] as const;

export function patchDricketDocument(content: string, target: TargetTicket): string {
  const lines = content.split('\n');
  if (lines[0] !== FENCE) {
    throw new Error('not a dricket document: no front matter fence');
  }
  const close = lines.indexOf(FENCE, 1);
  if (close < 0) {
    throw new Error('not a dricket document: front matter is not closed');
  }
  const set: Record<string, string> = {
    title: target.title,
    stage: target.stage,
    priority: target.priority,
    labels: target.labels.join(', '),
    depends: target.depends.join(', '),
    parent: target.parent ?? '',
    branch: target.branch ?? '',
    repos: target.repos.join(', '),
  };
  const header: string[] = [];
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : '';
    if (key.startsWith('x-')) {
      continue;
    }
    header.push(key in set ? `${key}: ${set[key]}` : line);
  }
  for (const [key, value] of Object.entries(target.extensions)) {
    header.push(`${key}: ${value}`);
  }
  return [FENCE, ...header, FENCE].join('\n') + '\n' + target.body;
}

/** A dk-shaped document for a target, as `dk add --unclaimed` would leave it (preview and tests). */
export function stubDocument(target: TargetTicket, createdAt = '1970-01-01T00:00:00Z', createdBy = 'migrate@scratch'): string {
  const base: Record<(typeof CANONICAL_ORDER)[number], string> = {
    id: target.id,
    created_at: createdAt,
    created_by: createdBy,
    schema_version: '1',
    title: target.title,
    stage: target.stage,
    owner: '',
    kind: target.kind,
    size: 'M',
    claimed_at: '',
    lease_until: '',
    epoch: '0',
    rev: '0',
    extensions: '0',
    priority: target.priority,
    labels: '',
    depends: '',
    parent: '',
    touches: '',
    branch: '',
    repos: '',
  };
  const lines = CANONICAL_ORDER.map((k) => `${k}: ${base[k]}`);
  return patchDricketDocument([FENCE, ...lines, FENCE, ''].join('\n'), target);
}
