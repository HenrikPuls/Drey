/**
 * The ticket card on top of the document (E13-6, boards 9a, 7b, 7c, 7j): drawn
 * by `ticket-header.ts`, which owns when it repaints.
 *
 * Two things arrive asynchronously and are cached for the session: the
 * persona names (one call) and the estimate of a (gate, persona) pair
 * (E11-4, one call per pair). Until they arrive the card draws without
 * them and the owner never waits on the header.
 */
import type { EditorView } from '@codemirror/view';
import { parseVerlaufEntries } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import type { BoardSnapshot, TicketCard, TicketIssue, TicketMeta } from '../../shared/tickets';
import type { WorkRow } from '../work-groups';
import { cardNode, type CardFacts } from './dom';
import { estimateInlineText, noEstimateText } from '../../../../shared/cost-text';
import type { I18n } from '../../../../shared/i18n/types';
import { cardOfDocument } from '../ticket-header';
import { actionBarOf, chainOf, costSummary, flowItemsOf, pageShapeOf, statusOf, titleCase, workerOf, type PersonaName } from './model';
import { hasOpenParts } from './parts-model';

export interface TicketStripDeps {
  /** The catalog (`api.i18n`): every word of the card comes through it. */
  readonly i18n: I18n;
  readonly snapshot: () => BoardSnapshot | null;
  readonly rowOf: (card: TicketCard) => WorkRow | null;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  readonly onThread: (card: TicketCard) => void;
  readonly onReview: (card: TicketCard) => void;
  /** Opens the ticket's Flow tab (E13-11); absent = no link. */
  readonly openFlow?: (card: TicketCard) => void;
  readonly icon?: (name: string, size?: number) => SVGElement;
}

export interface TicketStripInput {
  readonly path: string;
  readonly view: EditorView;
  /** The header's model of the buffer's frontmatter; null until it is read. */
  readonly meta: () => TicketMeta | null;
  readonly issues: () => readonly TicketIssue[];
  /** Shows the base's editable YAML instead of the card. */
  readonly expandRaw: () => void;
}

export interface TicketStrip {
  /** The card for the open document; `paint()` redraws it from the buffer and the board. */
  mount(input: TicketStripInput): { readonly node: HTMLElement; paint(): void };
}

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

/** The validator's real findings; `noise` (a missing stamp) is not worth a badge on the card. */
const issuesBadge = (all: readonly TicketIssue[]): CardFacts['issues'] => {
  const issues = all.filter((issue) => issue.level !== 'noise');
  return issues.length === 0
    ? null
    : {
        count: issues.length,
        worst: issues.some((i) => i.level === 'error') ? 'error' : 'warning',
        title: issues.map((i) => `[${i.level}] ${i.message}`).join('\n'),
      };
};

export function createTicketStrip(deps: TicketStripDeps): TicketStrip {
  let personas: readonly (PersonaName & { readonly color?: string })[] | null = null;
  let personasAsked = false;
  const estimates = new Map<string, RunEstimate | null>();
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const loadPersonas = (): void => {
    if (personasAsked) {
      return;
    }
    personasAsked = true;
    void deps
      .invoke('personas')
      .then((reply) => {
        personas = Array.isArray(reply)
          ? (reply as PersonaName[]).filter((p) => typeof p.id === 'string' && typeof p.title === 'string')
          : [];
        notify();
      })
      .catch(() => {
        personasAsked = false;
      });
  };

  const estimateFor = (gate: string, persona: string): RunEstimate | null => {
    const key = `${gate}|${persona}`;
    if (!asked.has(key)) {
      asked.add(key);
      void deps
        .invoke('estimate', { gate, persona })
        .then((reply) => {
          const estimate = (reply as { estimate?: RunEstimate | null } | null)?.estimate ?? null;
          estimates.set(key, estimate);
          notify();
        })
        .catch(() => asked.delete(key));
    }
    return estimates.get(key) ?? null;
  };

  return {
    mount: ({ path, view, meta, issues, expandRaw }) => {
      const host = document.createElement('div');
      host.className = 'tickets-doc-strip-host';
      const paint = (): void => {
        const snapshot = deps.snapshot();
        const card = cardOfDocument(snapshot, path);
        if (snapshot === null || card === null) {
          host.replaceChildren();
          return;
        }
        loadPersonas();
        const text = view.state.doc.toString();
        const row = deps.rowOf(card);
        const phase = snapshot.pipeline.find((p) => p.id === card.phase);
        const phaseTitle = phase?.title ?? card.phase;
        const chain = chainOf({ pipeline: snapshot.pipeline, currentPhaseId: card.phase, card, personas: personas ?? [] });
        const planToAccept = card.phase === 'shaping' && hasOpenParts(text);
        const status = statusOf(deps.i18n, row, snapshot, phaseTitle, planToAccept);
        const shape = pageShapeOf(card.phase, snapshot.pipeline);
        const entries = parseVerlaufEntries(text);
        const cost = costSummary(deps.i18n, entries, row?.need !== null && row?.run === null);
        // The estimate sits beside the cost it belongs to: `$1.20 so far · est. $3.00–5.20 · from 3 runs`.
        const worker = workerOf(chain);
        let estimate: string | null = null;
        if (worker !== null && worker.personaId !== null && row?.run == null) {
          const found = estimateFor(worker.phase, worker.personaId);
          estimate = found === null ? noEstimateText(deps.i18n) : estimateInlineText(deps.i18n, found);
        }
        const need = row?.need ?? null;
        const own = meta() ?? card.meta;
        const pinned = worker?.personaId === null ? undefined : personas?.find((p) => p.id === worker?.personaId);
        const facts: CardFacts = {
          shape,
          id: own.id ?? card.id,
          pill: { label: phaseTitleOrArchive(status.label, card.phase), tone: status.pill },
          kind: status.kind,
          issues: issuesBadge(issues()),
          flow: flowItemsOf(deps.i18n, chain, card.phase, planToAccept),
          priority: own.priority === null || own.priority === undefined ? deps.i18n.t('ticket.card.none') : titleCase(own.priority),
          worker: shape === 'early' ? (own.worker ?? deps.i18n.t('ticket.card.default')) : (worker?.who ?? deps.i18n.t('ticket.card.none')),
          workerNote: shape === 'early' && own.worker !== null ? `· ${own.persona ?? deps.i18n.t('ticket.card.default')}` : '',
          avatar:
            card.phase === 'shaping' && !planToAccept && worker !== null
              ? { initials: initialsOf(worker.who), color: pinned?.color ?? '', name: worker.who }
              : null,
          repo: own.repo ?? deps.i18n.t('ticket.card.none'),
          branch: own.branch ?? '',
          cost: [cost.label, estimate].filter((part): part is string => part !== null).join(' · '),
          gate: need !== null && need.text.trim() !== '' ? deps.i18n.t('ticket.waits_for_you', { text: need.text.trim() }) : '',
          decide: actionBarOf(row, snapshot).decide,
          canReview: chain.some((step) => step.state !== 'future'),
        };
        host.replaceChildren(
          cardNode(
            {
              i18n: deps.i18n,
              onThread: () => deps.onThread(card),
              onReview: () => deps.onReview(card),
              ...(deps.openFlow === undefined ? {} : { onFlow: () => deps.openFlow?.(card) }),
              ...(deps.icon === undefined ? {} : { icon: deps.icon, onRaw: expandRaw }),
            },
            facts,
          ),
        );
      };
      // A listener lives while its card is in the page; once it was shown
      // and left again, the next notification drops it.
      let shown = false;
      const listener = (): void => {
        if (host.isConnected) {
          shown = true;
          paint();
        } else if (shown) {
          listeners.delete(listener);
        }
      };
      listeners.add(listener);
      paint();
      return { node: host, paint };
    },
  };
}

/** An archived ticket has left the pipeline: its pill says so. */
const phaseTitleOrArchive = (label: string, phase: string): string => (phase === 'archive' ? 'Archived' : label);
