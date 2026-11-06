import { parse, stringify } from 'yaml';

import { PIPELINE_PROSE } from '../core/pipeline-states';

/**
 * The legacy vault's `_meta/pipeline.md` -> the file of the six stages (req-99a).
 * The tickets move into the store, but the pipeline stays in the meta vault, so the
 * cut-over needs this file written together with the import: a board whose pipeline
 * still names `build` shows every ticket of the new store as an unknown column.
 *
 * Pure. What the owner configured survives: top-level keys (`push:`, `priorities:`,
 * ...) and the keys of the old build column on Building. An agent column's budget and
 * persona do not travel to the manual Ready to try; they are reported.
 */

export interface PipelineConversion {
  readonly text: string;
  /** What did not travel, in words. */
  readonly dropped: readonly string[];
}

type Phase = Record<string, unknown>;

/** The keys a column keeps on any stage: only its look. */
const LOOK_KEYS: readonly string[] = ['color'];

export function sixStagePipelineText(legacy: string): PipelineConversion {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(legacy);
  if (match === null) {
    throw new Error('the pipeline file has no frontmatter');
  }
  const front = parse(match[1]!) as Record<string, unknown> | null;
  const oldPhases = front?.['phases'];
  if (!Array.isArray(oldPhases) || oldPhases.length === 0) {
    throw new Error('the pipeline file lists no phases');
  }
  const byId = new Map((oldPhases as Phase[]).map((phase) => [String(phase['id']), phase] as const));
  const dropped: string[] = [];

  const manual = (id: string, title: string, ...sources: string[]): Phase => {
    const source = sources.map((s) => byId.get(s)).find((p) => p !== undefined);
    const look = source === undefined ? {} : Object.fromEntries(LOOK_KEYS.filter((k) => k in source).map((k) => [k, source[k]]));
    return { id, title, handover: 'manual', persona: 'you', ...look };
  };
  const build = byId.get('build');
  const building: Phase = {
    ...(build === undefined ? { wip: 3 } : Object.fromEntries(Object.entries(build).filter(([key]) => key !== 'id' && key !== 'title'))),
    id: 'building',
    title: 'Building',
    claim: true,
  };
  if (typeof building['handover'] !== 'string' || !building['handover'].startsWith('agent')) {
    building['handover'] = 'agent build-default';
  }
  const phases: Phase[] = [
    manual('inbox', 'Inbox', 'inbox'),
    manual('shaping', 'Shaping', 'plan'),
    manual('prioritized', 'Prioritized', 'prioritized'),
    building,
    manual('ready', 'Ready to try', 'sign-off', 'commit', 'review'),
    { id: 'done', title: 'Done', handover: 'none', ...(byId.get('done')?.['color'] !== undefined ? { color: byId.get('done')!['color'] } : {}) },
  ];

  const carried = new Set(['inbox', 'plan', 'prioritized', 'build', 'review', 'sign-off', 'commit', 'done']);
  for (const [id, phase] of byId) {
    if (!carried.has(id)) {
      dropped.push(`column "${id}" has no stage: a ticket in it needs a place before the import`);
      continue;
    }
    if (id === 'build' || id === 'done') {
      continue;
    }
    const lost = Object.keys(phase).filter((key) => !['id', 'title', 'handover', 'persona', ...LOOK_KEYS].includes(key));
    const agent = typeof phase['handover'] === 'string' && phase['handover'].startsWith('agent');
    if (agent || lost.length > 0) {
      dropped.push(`column "${id}": ${[agent ? `handover ${String(phase['handover'])}` : '', ...lost].filter((x) => x !== '').join(', ')}`);
    }
  }

  const yamlText = stringify({ ...front, phases }, { lineWidth: 0 });
  return { text: `---\n${yamlText}---\n${PIPELINE_PROSE}`, dropped };
}
