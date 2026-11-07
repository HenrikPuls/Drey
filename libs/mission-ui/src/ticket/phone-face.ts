import type { MessageKey, MessageParams } from '../../../../shared/i18n';
import type { McPartCard } from '../api/dto';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The flow row of the phone's ticket (board 10d): done steps, the current one, what is to come. */
export interface PhoneFlowLine {
  readonly past: string;
  readonly current: string | null;
  /** `(step 2 of 4)`, or `(your turn)` on the owner's last step; null = nothing to add. */
  readonly note: string | null;
  readonly rest: string;
}

interface FlowStep {
  readonly title: string;
  readonly state: 'past' | 'current' | 'future';
  readonly skipped?: boolean;
}

export function flowLineOf(
  steps: readonly FlowStep[],
  parts: { readonly done: number; readonly total: number } | null,
  yourTurn: boolean,
  t: Translate,
): PhoneFlowLine {
  const live = steps.filter((step) => step.skipped !== true);
  const current = live.find((step) => step.state === 'current') ?? null;
  const rest = live.filter((step) => step.state === 'future').map((step) => step.title);
  const past = live.filter((step) => step.state === 'past').map((step) => `✓ ${step.title}`);
  const note = yourTurn
    ? t('ticket.phone.your_turn')
    : parts !== null
      ? t('ticket.phone.step_of', { n: Math.min(parts.done + 1, parts.total), total: parts.total })
      : null;
  return {
    past: past.join(' · '),
    current: current?.title ?? null,
    note,
    rest: rest.length === 0 ? '' : `${current === null && past.length === 0 ? '' : '· '}${rest.join(' · ')}`,
  };
}

/** One Parts row of the phone's ticket. */
export interface PhonePartRow {
  readonly key: string;
  readonly title: string;
  readonly state: 'done' | 'running' | 'waiting';
  readonly mark: string;
  readonly sub: string;
  /** The estimate while the part waits; spent cost per part is not on the wire. */
  readonly cost: string | null;
}

function stateOf(card: McPartCard | null): PhonePartRow['state'] {
  if (card === null) {
    return 'waiting';
  }
  if (card.state === 'done') {
    return 'done';
  }
  return card.state === 'running' || card.state === 'active' ? 'running' : 'waiting';
}

const MARKS: Readonly<Record<PhonePartRow['state'], string>> = { done: '✓', running: '●', waiting: '○' };

/**
 * The Parts rows: the desk's cards when it answered, else the plan's own
 * lines, every part waiting. Spent cost per part is not on the wire.
 */
export function partRowsOf(
  planParts: readonly { readonly title: string; readonly persona: string | null }[],
  cards: readonly McPartCard[] | null,
  personaName: (id: string) => string,
  estimate: (persona: string) => string | null,
  t: Translate,
): readonly PhonePartRow[] {
  const source = cards ?? planParts.map((part) => ({ ...part, card: null }));
  return source.map((entry, index) => {
    const card = cards === null ? null : (entry as McPartCard);
    const state = stateOf(card);
    const word = t(`ticket.phone.part.${state}`);
    const persona = entry.persona ?? null;
    return {
      key: `${index}:${entry.title}`,
      title: entry.title,
      state,
      mark: MARKS[state],
      sub: persona === null ? word : `${word} · ${personaName(persona)}`,
      cost: state === 'waiting' && persona !== null ? estimate(persona) : null,
    };
  });
}

/** The ticket body without its Parts chapter, the rows draw that; every other chapter stays. */
export function withoutPartsChapter(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let skipLevel: number | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (skipLevel !== null && level <= skipLevel) {
        skipLevel = null;
      }
      if (skipLevel === null && heading[2]!.trim().toLowerCase() === 'parts') {
        skipLevel = level;
        continue;
      }
    }
    if (skipLevel === null) {
      kept.push(line);
    }
  }
  return kept.join('\n').trim();
}
