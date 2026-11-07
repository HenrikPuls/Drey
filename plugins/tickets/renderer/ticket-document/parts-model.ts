/**
 * The Parts block in the ticket (E13-10, E12-17, board 7c), the pure half: where
 * the `### Parts` list sits in the text and what one card of the block says. The
 * cards come from the engine's plan routes (E10-4); nothing here writes the file.
 */
import { maskFenceLines } from '../../../../shared/markdown/fences';
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import type { PartState, PlanPartCard, PlanPartsReply } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import { estimateText, noEstimateText } from '../../../../shared/cost-text';
import type { I18n } from '../../../../shared/i18n/types';
import type { TextRange } from './model';

/** The `### Parts` chapter, heading included, to the end of its last non-blank line; null without one. */
export function partsRange(text: string): TextRange | null {
  const lines = text.split('\n');
  const scan = maskFenceLines(lines);
  let offset = 0;
  let from: number | null = null;
  let to: number | null = null;
  for (const [i, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const probe = scan[i]!.endsWith('\r') ? scan[i]!.slice(0, -1) : scan[i]!;
    if (from === null) {
      if (/^###\s+Parts\s*$/.test(probe)) {
        from = offset;
        to = offset + line.length;
      }
    } else if (/^#{1,3}\s/.test(probe)) {
      break;
    } else if (line.trim() !== '') {
      to = offset + line.length;
    }
    offset += raw.length + 1;
  }
  return from !== null && to !== null ? { from, to } : null;
}

/** Whether the plan lists a part that is no ticket yet: the plan is still to accept. */
export function hasOpenParts(text: string): boolean {
  const range = partsRange(text);
  return range !== null && /^- \[ \] /m.test(text.slice(range.from, range.to));
}

const STATE_GLYPH: Record<PartState, string> = { new: '○', queued: '○', running: '●', active: '●', done: '✓' };

export interface PartView {
  readonly index: number;
  readonly label: string;
  readonly title: string;
  /** `starts first · Mod+Alt+T, focus handling`. */
  readonly line: string;
  readonly stateGlyph: string;
  readonly stateLabel: string;
  readonly personaId: string | null;
  readonly personaName: string;
  readonly personaColor: string;
  /** `$1.10–1.80`; '' when the part has no estimate yet. */
  readonly estimate: string;
  /** The grey words beside it: `from 3 runs` or `no estimate yet (first run)`. */
  readonly basis: string;
  readonly locked: boolean;
}

export interface PartsView {
  readonly ticket: string;
  readonly count: string;
  /** `$3.00–5.20`; '' while no part has an estimate. */
  readonly total: string;
  readonly parts: readonly PartView[];
  /** A part carries its own chain delta: the flow is not the standard one. */
  readonly edited: boolean;
  readonly personas: readonly { readonly id: string; readonly title: string }[];
}

/** What the part's line says about when it starts, in the board's words. */
function startWords(i18n: I18n, card: PlanPartCard): string {
  if (card.state !== 'new') {
    return card.start;
  }
  const after = /(\d+)/.exec(card.start);
  return after === null ? i18n.t('ticket.parts.starts_first') : i18n.t('ticket.parts.after', { n: Number(after[1]) });
}

/** Splits `$1.10–1.80 · from 3 runs` into the amount and its grey basis. */
function splitEstimate(i18n: I18n, estimate: RunEstimate | null): { amount: string; basis: string } {
  if (estimate === null) {
    return { amount: '', basis: noEstimateText(i18n) };
  }
  const words = estimateText(i18n, estimate);
  const cut = words.indexOf(' · ');
  return cut < 0 ? { amount: words, basis: '' } : { amount: words.slice(0, cut), basis: words.slice(cut + 3) };
}

/** The block's words from the engine's cards and the estimates known so far. */
export function partsViewOf(
  i18n: I18n,
  reply: Extract<PlanPartsReply, { ok: true }>,
  estimateOf: (gate: string, persona: string) => RunEstimate | null,
): PartsView {
  let low = 0;
  let high = 0;
  let known = 0;
  const personaOf = (id: string | null) => reply.personas.find((persona) => persona.id === id) ?? null;
  const parts = reply.parts.map((card): PartView => {
    const personaId = card.persona ?? reply.defaultPersona;
    const persona = personaOf(personaId);
    const estimate = personaId === null ? null : estimateOf(reply.gate, personaId);
    if (typeof estimate?.costLow === 'number' && typeof estimate.costHigh === 'number') {
      low += estimate.costLow;
      high += estimate.costHigh;
      known += 1;
    }
    const words = splitEstimate(i18n, estimate);
    return {
      index: card.index,
      label: `P${card.index + 1}`,
      title: card.title,
      line: [startWords(i18n, card), card.reason].filter((part): part is string => part !== null && part !== '').join(' · '),
      stateGlyph: STATE_GLYPH[card.state],
      stateLabel: i18n.t(`ticket.parts.state.${card.state}`),
      personaId,
      personaName: persona?.title ?? personaId ?? i18n.t('ticket.parts.persona_default'),
      personaColor: persona?.color ?? '',
      estimate: words.amount,
      basis: words.basis,
      locked: card.locked,
    };
  });
  const range = known === 0 ? null : i18n.currencyRange(low, high);
  return {
    ticket: reply.ticket,
    count: i18n.t('ticket.parts.count', { n: parts.length }),
    total: range === null ? '' : range.high === '' ? range.low : `${range.low}–${range.high}`,
    parts,
    edited: reply.parts.some((card) => card.chain.length > 0),
    personas: reply.personas.map((persona) => ({ id: persona.id, title: persona.title })),
  };
}
