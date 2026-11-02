/**
 * The `## Verlauf` chapter (concept §5.4): the machine-maintained,
 * append-only run history inside the ticket file — one inline-YAML line
 * per COMPLETED run, carrying what git does not know: tokens, cost,
 * duration and the outcome.
 *
 *     ## Verlauf
 *
 *     - { phase: plan, persona: pia, model: opus, tokens: 48k, cost: 1.17, dauer: 12m, ausgang: handed-over }
 *     - { phase: build, persona: ben, model: glm-5.3, tokens: 121k, cost: 0.427, dauer: 41m, ausgang: failed }
 *
 * Newest entries at the bottom; existing lines are never rewritten. A
 * run with no tokens and no cost writes nothing. The reader forgives
 * (the asymmetric-tolerance rule): a torn or hand-edited line degrades
 * to nulls, never a guess.
 */

/** The outcome a settled run can report (the supervisor's terminal states). */
export type VerlaufOutcome = 'handed-over' | 'failed' | 'stopped';

/** One Verlauf line, both directions. */
export interface VerlaufEntry {
  readonly phase: string | null;
  readonly persona: string | null;
  readonly model: string | null;
  /** The compact token words the Log uses too (`48k`, `3.4M`, `800`). */
  readonly tokens: string;
  readonly cost: number | null;
  /** Whole minutes (`12m`); a sub-minute run is `0m`. */
  readonly dauer: string;
  readonly ausgang: VerlaufOutcome | null;
}

export const VERLAUF_HEADING = '## Verlauf';

/** 331122 -> `331k`, 3_400_000 -> `3.4M`: the Log's short token counts. */
function tokenWords(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

/** The dollars as written: the ledger's four digits, trailing zeros trimmed by `String`. */
function costWords(cost: number): string {
  return String(Math.round(cost * 10_000) / 10_000);
}

/**
 * Builds one entry from the settled run's facts: the outcome maps
 * `done → handed-over`, `failed → failed`, everything else `stopped`
 * (the same mapping the persona memory line uses); the duration runs
 * from start to settle on the wall clock.
 */
export function verlaufEntryOf(input: {
  readonly phase: string | null;
  readonly persona: string | null;
  readonly model: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly state: string;
}): VerlaufEntry {
  const start = Date.parse(input.startedAt);
  const end = input.endedAt === null ? Number.NaN : Date.parse(input.endedAt);
  // Whole minutes on the floor — a sub-minute run reads 0m, an hour plus
  // a tail reads the full minutes.
  const minutes = Number.isNaN(start) || Number.isNaN(end) || end <= start ? 0 : Math.floor((end - start) / 60_000);
  const ausgang: VerlaufOutcome = input.state === 'done' ? 'handed-over' : input.state === 'failed' ? 'failed' : 'stopped';
  return {
    phase: input.phase,
    persona: input.persona,
    model: input.model,
    tokens: tokenWords(input.tokensIn + input.tokensOut),
    cost: input.cost,
    dauer: `${minutes}m`,
    ausgang,
  };
}

/** The inline-YAML line for one entry (all seven keys, always). */
export function renderVerlaufLine(entry: VerlaufEntry): string {
  const part = (key: string, value: string | number | null): string =>
    ` ${key}: ${value === null ? 'null' : value}`;
  return (
    `- {${part('phase', entry.phase)},${part('persona', entry.persona)},${part('model', entry.model)},` +
    `${part('tokens', entry.tokens)},${part('cost', entry.cost)},${part('dauer', entry.dauer)},` +
    `${part('ausgang', entry.ausgang)} }`
  );
}

/**
 * Appends one rendered line to the ticket file's `## Verlauf` chapter:
 * newest at the bottom of the existing section; a missing section is
 * created before `## Log` (else at the end of the file). Everything
 * outside the chapter survives byte-identical.
 */
export function appendVerlaufEntry(fileText: string, line: string): string {
  const lines = fileText.split('\n');
  let headingAt = -1;
  let nextHeadingAt = -1;
  let logAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Verlauf\s*$/.test(lines[i]!)) {
      headingAt = i;
    } else if (headingAt >= 0 && nextHeadingAt === -1 && /^##\s/.test(lines[i]!)) {
      // The first heading after the chapter ends it — a trailing `## Log`
      // included (the Log branch below must not shadow this one).
      nextHeadingAt = i;
    } else if (/^##\s+Log\s*$/.test(lines[i]!)) {
      logAt = i;
    }
  }
  if (headingAt >= 0) {
    let at = nextHeadingAt === -1 ? lines.length : nextHeadingAt;
    // Insert before trailing empties so the section keeps its blank line end.
    while (nextHeadingAt === -1 && at > headingAt + 1 && lines[at - 1]!.trim() === '') {
      at--;
    }
    lines.splice(at, 0, line);
    return lines.join('\n');
  }
  if (logAt >= 0) {
    lines.splice(logAt, 0, VERLAUF_HEADING, '', line, '');
    return lines.join('\n');
  }
  const head = fileText.endsWith('\n') || fileText === '' ? '' : '\n';
  return `${fileText}${head}\n${VERLAUF_HEADING}\n\n${line}\n`;
}

/** The section's lines, tolerantly read back; [] when the chapter is absent. */
export function parseVerlaufEntries(fileText: string): readonly VerlaufEntry[] {
  const heading = /^##\s+Verlauf\s*$/m.exec(fileText);
  if (heading === null) {
    return [];
  }
  const rest = fileText.slice(heading.index);
  const bodyStart = rest.indexOf('\n') + 1;
  const next = /^## /gm.exec(rest.slice(bodyStart));
  const section = next === null ? rest : rest.slice(0, bodyStart + next.index);
  const entries: VerlaufEntry[] = [];
  for (const line of section.split('\n')) {
    const match = /^- \{(.+)\}\s*$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const pair of match[1]!.split(',')) {
      const at = pair.indexOf(':');
      if (at === -1) {
        continue;
      }
      fields.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    const str = (key: string): string | null => {
      const value = fields.get(key);
      return value === undefined || value === '' || value === 'null' ? null : value;
    };
    const costRaw = str('cost');
    const cost = costRaw === null || Number.isNaN(Number(costRaw)) ? null : Number(costRaw);
    entries.push({
      phase: str('phase'),
      persona: str('persona'),
      model: str('model'),
      tokens: fields.get('tokens') ?? '',
      cost,
      dauer: fields.get('dauer') ?? '',
      ausgang: str('ausgang') as VerlaufOutcome | null,
    });
  }
  return entries;
}
