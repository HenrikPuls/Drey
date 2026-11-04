/**
 * The ticket header's strip (E13-6): status chip, persona, cost and
 * estimate, the chain with who does what, and the gate — drawn under the
 * req-62 chip row by `ticket-header.ts`, which owns when it repaints.
 *
 * Two things arrive asynchronously and are cached for the session: the
 * persona names (one call) and the estimate of a (gate, persona) pair
 * (E11-4, one call per pair). Until they arrive the strip draws without
 * them and the owner never waits on the header.
 */
import type { EditorView } from '@codemirror/view';
import { parseVerlaufEntries } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { WorkRow } from '../work-groups';
import { stripNode, type StripData } from './dom';
import { chainOf, costSummary, currentStep, estimateLine, statusOf, usdLabel, type PersonaName } from './model';

export interface TicketStripDeps {
  readonly snapshot: () => BoardSnapshot | null;
  readonly rowOf: (card: TicketCard) => WorkRow | null;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
}

export interface TicketStrip {
  /** The strip for the open document; `paint()` redraws it from the buffer and the board. */
  mount(input: { readonly path: string; readonly view: EditorView }): { readonly node: HTMLElement; paint(): void };
}

export function createTicketStrip(deps: TicketStripDeps): TicketStrip {
  let personas: readonly PersonaName[] | null = null;
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
    mount: ({ path, view }) => {
      const host = document.createElement('div');
      host.className = 'tickets-doc-strip-host';
      const paint = (): void => {
        const snapshot = deps.snapshot();
        const card = snapshot?.columns.flatMap((column) => column.tickets).find((ticket) => ticket.path === path) ?? null;
        if (snapshot === null || card === null) {
          host.replaceChildren();
          return;
        }
        loadPersonas();
        const row = deps.rowOf(card);
        const phase = snapshot.pipeline.find((p) => p.id === card.phase);
        const phaseTitle = phase?.title ?? card.phase;
        const chain = chainOf({ pipeline: snapshot.pipeline, currentPhaseId: card.phase, card, personas: personas ?? [] });
        const step = currentStep(chain);
        const status = statusOf(row, snapshot, phaseTitle);
        const entries = parseVerlaufEntries(view.state.doc.toString());
        const cost = costSummary(entries, row?.need !== null && row?.run === null);
        let estimate: StripData['estimate'] = null;
        if (step !== null && !step.checkpoint && step.personaId !== null && row?.run == null) {
          const found = estimateFor(step.phase, step.personaId);
          if (found !== null) {
            estimate = {
              short: [usdLabel(found.cost) ?? `$${found.cost.toFixed(2)}`, found.minutes === null ? '' : `${found.minutes} min`]
                .filter((part) => part !== '')
                .join(' · '),
              basis: estimateLine(found, step.title),
            };
          }
        }
        const need = row?.need ?? null;
        host.replaceChildren(
          stripNode({
            status,
            who: step?.who ?? '',
            cost: cost.label,
            estimate,
            chain,
            gate: need !== null && need.text.trim() !== '' ? `Waits for you: ${need.text.trim()}` : '',
          }),
        );
      };
      // A listener lives while its strip is in the page; once it was shown
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
