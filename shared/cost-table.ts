/**
 * The cost-by-phase table at the end of a ticket (req-98, concept §5.4,
 * canvas decision 19): Phase · Model · Tokens · Time · Cost and a total
 * row. Every figure comes from the runs the ticket already carries — the
 * `## Verlauf` entries — and a phase the ticket still has to pass says so
 * quietly instead of showing a zero. Every word is a catalog key.
 */
import type { I18n } from './i18n/types';

/** The fields of a `## Verlauf` run the table reads — the engine's entry and Mission Control's both fit. */
export interface RunLine {
  readonly phase: string | null;
  readonly persona: string | null;
  readonly model: string | null;
  readonly tokens: string;
  readonly cost: number | null;
  readonly dauer: string;
  readonly ausgang: string | null;
}

export interface CostTableRow {
  readonly phase: string;
  /** `Ben · sonnet`; '' when the run recorded neither (or no run yet). */
  readonly model: string;
  /** `48k`; '' when unknown. */
  readonly tokens: string;
  /** `9 min`; '' when unknown. */
  readonly time: string;
  /** The desktop's words apart (board 7j): the persona beside the phase, the model alone, the minutes; ''/null when unknown. */
  readonly persona: string;
  readonly modelName: string;
  readonly minutes: number | null;
  /** `$0.30`; `—` for a run that recorded no cost; '' for a phase without a run. */
  readonly cost: string;
  /** True for a phase of the chain that has no run yet: the row reads `no run yet`. */
  readonly pending: boolean;
  /** A run that failed or was stopped: its row is drawn in the warning tone. */
  readonly bad: boolean;
  /** The grey line under the phase on a phone: Model · Tokens · Time, the parts that are known. */
  readonly meta: string;
}

export interface CostTableTotal {
  readonly tokens: string;
  readonly time: string;
  /** `$1.84`; `—` while no run cost anything readable. */
  readonly cost: string;
}

export interface CostTableView {
  readonly rows: readonly CostTableRow[];
  readonly total: CostTableTotal;
}

/** A phase of the ticket's chain that may still be waiting for its first run. */
export interface CostPhase {
  readonly id: string;
  readonly title: string;
  /** A manual step (a checkpoint) has no run and so no row. */
  readonly checkpoint?: boolean;
  /** A skipped step never runs. */
  readonly skipped?: boolean;
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const minutesOf = (words: string): number | null => {
  const match = /^(\d+)m$/.exec(words.trim());
  return match === null ? null : Number(match[1]);
};

const tokenCountOf = (words: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(words.trim());
  return match === null ? null : Math.round(Number(match[1]) * (match[2] === 'M' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1));
};

/** 48000 → `48k`, 3400000 → `3.4M`: the Log's token words. */
export function tokenWords(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

const knownCost = (cost: number | null): cost is number => typeof cost === 'number' && Number.isFinite(cost) && cost > 0;

/**
 * One row per settled run, oldest first as written, then one `no run yet`
 * row per phase of the chain that has not run; the total under them. An
 * unknown figure is blank and never counts as zero.
 */
export function costTableOf(
  i18n: I18n,
  entries: readonly RunLine[],
  phaseTitle: (id: string) => string,
  chain: readonly CostPhase[] = [],
): CostTableView {
  let minutes: number | null = null;
  let cost: number | null = null;
  let tokens: number | null = null;
  const ran = new Set<string>();
  const rows: CostTableRow[] = entries.map((entry) => {
    const mins = minutesOf(entry.dauer);
    if (mins !== null) {
      minutes = (minutes ?? 0) + mins;
    }
    if (knownCost(entry.cost)) {
      cost = (cost ?? 0) + entry.cost;
    }
    const count = tokenCountOf(entry.tokens);
    if (count !== null) {
      tokens = (tokens ?? 0) + count;
    }
    if (entry.phase !== null) {
      ran.add(entry.phase.trim().toLowerCase());
    }
    const model = [entry.persona === null ? '' : titleCase(entry.persona), entry.model ?? ''].filter((p) => p !== '').join(' · ');
    const time = mins === null ? '' : i18n.t('cost.table.minutes', { n: mins });
    return {
      phase: entry.phase === null ? '—' : phaseTitle(entry.phase),
      model,
      persona: entry.persona === null ? '' : titleCase(entry.persona),
      modelName: entry.model ?? '',
      minutes: mins,
      tokens: entry.tokens,
      time,
      cost: knownCost(entry.cost) ? i18n.formatCurrency(entry.cost) : '—',
      pending: false,
      bad: entry.ausgang === 'failed' || entry.ausgang === 'stopped',
      meta: [model, entry.tokens, time].filter((p) => p !== '').join(' · '),
    };
  });
  for (const phase of chain) {
    if (phase.checkpoint === true || phase.skipped === true || ran.has(phase.id.trim().toLowerCase())) {
      continue;
    }
    rows.push({ phase: phase.title, model: '', persona: '', modelName: '', minutes: null, tokens: '', time: '', cost: '', pending: true, bad: false, meta: '' });
  }
  return {
    rows,
    total: {
      tokens: tokens === null ? '' : tokenWords(tokens),
      time: minutes === null ? '' : i18n.t('cost.table.minutes', { n: minutes }),
      cost: cost === null ? '—' : i18n.formatCurrency(cost),
    },
  };
}
