/**
 * The Board tab (E13-8; design board DeskBoard): the pipeline as columns,
 * one card per ticket - id, what waits on the owner, title, persona and
 * cost - the parts of a ticket under it (released parts are tickets with
 * `parent:`, the plan's unreleased parts come from `planParts`), the cost
 * of each column in its head and "Done this week" last. Reads the shared
 * board store; a card opens the ticket page. Plain DOM over
 * `board-model.ts`. The Filter and Cost-by-column buttons of board 7e
 * are E13-17 and not built yet.
 */
import type { PlanPartCard } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import type { PlanPartsReply } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import { h, textButton, type DeskDeps } from '../desk-deps';
import type { TeamStore } from '../team/team-store';
import { usd } from '../team/team-model';
import {
  boardModelOf,
  columnCostText,
  planCandidatesOf,
  type BoardCardModel,
  type BoardColumnModel,
  type BoardPartModel,
} from './board-model';

/** How many cards a column shows before its "<n> more" row (board 7e). */
const COLUMN_SHOWN = 4;

function partNode(deps: DeskDeps, store: TeamStore, part: BoardPartModel): HTMLElement {
  const row = h('div', `desk-part${part.card === null ? ' desk-part-plan' : ''}`);
  row.append(h('span', 'desk-part-handle', part.handle), h('span', 'desk-part-title', part.title));
  if (part.personaId !== null && part.personaId !== '') {
    row.append(h('span', 'desk-part-who', store.nameOf(part.personaId)));
  }
  const target = part.card;
  if (target !== null) {
    row.classList.add('desk-part-open');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.openTicket(target);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        deps.openTicket(target);
      }
    });
  }
  return row;
}

/** Parts hang under a card as "P1 title persona" rows; a released part shows its ticket id instead. */
function partsNode(deps: DeskDeps, store: TeamStore, parts: readonly BoardPartModel[]): HTMLElement {
  const box = h('div', 'desk-parts');
  for (const part of parts) {
    box.append(partNode(deps, store, part));
  }
  return box;
}

function cardNode(deps: DeskDeps, store: TeamStore, card: BoardCardModel): HTMLElement {
  const node = h('article', `desk-card${card.kind !== '' ? ' desk-card-need' : ''}`);
  node.dataset['id'] = card.id;
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${card.id} ${card.title}`);
  node.title = `${card.id} - ${card.title}\n${card.card.path}`;
  const open = (): void => deps.openTicket(card.card);
  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === node) {
      event.preventDefault();
      open();
    }
  });
  const top = h('div', 'desk-card-top');
  top.append(h('span', 'desk-card-id', card.id));
  if (card.kind !== '') {
    top.append(h('span', 'desk-card-kind', card.kind));
  }
  node.append(top, h('div', 'desk-card-title', card.title));
  const foot = h('div', 'desk-card-foot');
  const assigned = card.personaId !== null && card.personaId !== '';
  const who = assigned ? store.nameOf(card.personaId ?? '') : 'unassigned';
  const doing = card.line === '' ? '' : ` · ${card.line}`;
  const whoNode = h('span', 'desk-card-who', `${who}${doing}`);
  whoNode.title = assigned ? `Persona: ${who}` : 'No persona works this ticket yet';
  foot.append(whoNode);
  if (card.cost !== null) {
    foot.append(h('span', 'desk-card-cost', usd(card.cost)));
  }
  node.append(foot);
  if (card.parts.length > 0) {
    node.append(partsNode(deps, store, card.parts));
  }
  return node;
}

function doneCardNode(entry: { readonly id: string; readonly title: string }): HTMLElement {
  const node = h('article', 'desk-card desk-card-done');
  node.dataset['id'] = entry.id;
  const top = h('div', 'desk-card-top');
  top.append(h('span', 'desk-card-id', entry.id));
  node.append(top, h('div', 'desk-card-title', entry.title));
  return node;
}

/** "<n> more" under a column; one click unfolds the column (this tab only). */
function moreNode(count: number, onClick: () => void): HTMLElement {
  const more = h('button', 'desk-more', `${count} more`);
  more.type = 'button';
  more.addEventListener('click', onClick);
  return more;
}

function columnHead(title: string, count: number, cost: string): HTMLElement {
  const head = h('div', 'desk-col-head');
  head.append(h('span', 'desk-col-title', title), h('span', 'desk-col-count', String(count)));
  if (cost !== '') {
    const costEl = h('span', 'desk-col-cost', cost);
    costEl.title = 'Settled cost of the tickets in this column';
    head.append(costEl);
  }
  return head;
}

function columnNode(deps: DeskDeps, store: TeamStore, column: BoardColumnModel, unfolded: Set<string>, repaint: () => void): HTMLElement {
  const node = h('section', 'desk-col');
  node.dataset['phase'] = column.id;
  node.append(columnHead(column.title, column.cards.length, columnCostText(column)));
  const body = h('div', 'desk-col-body');
  const open = unfolded.has(column.id);
  for (const card of open ? column.cards : column.cards.slice(0, COLUMN_SHOWN)) {
    body.append(cardNode(deps, store, card));
  }
  if (column.cards.length > COLUMN_SHOWN && !open) {
    body.append(
      moreNode(column.cards.length - COLUMN_SHOWN, () => {
        unfolded.add(column.id);
        repaint();
      }),
    );
  }
  node.append(body);
  return node;
}

export function mountBoard(deps: DeskDeps, store: TeamStore, host: HTMLElement): () => void {
  const root = h('div', 'desk-board');
  host.append(root);
  let frame = 0;
  let disposed = false;
  /** Plan parts per planning ticket; filled by the asks below. */
  const parts = new Map<string, readonly PlanPartCard[]>();
  /** The columns the owner unfolded ("<n> more"); per tab, never saved. */
  const unfolded = new Set<string>();
  const asked = new Set<string>();
  let askedFor: unknown = null;

  const askPlans = (): void => {
    const snap = deps.snapshot();
    if (snap === null) {
      return;
    }
    for (const id of planCandidatesOf(snap)) {
      if (asked.has(id)) {
        continue;
      }
      asked.add(id);
      void deps
        .invoke('planParts', { id })
        .then((reply) => {
          const plan = reply as PlanPartsReply;
          if (!disposed && plan.ok && plan.parts.some((part) => part.ticket === null)) {
            parts.set(id, plan.parts);
            schedule();
          }
        })
        .catch(() => undefined);
    }
  };

  const render = (): void => {
    frame = 0;
    const snap = deps.snapshot();
    const head = h('header', 'desk-head');
    head.append(h('h2', 'desk-h', 'Board'), h('span', 'desk-head-spacer'));
    if (snap === null || snap.vaultId === null) {
      root.replaceChildren(head, h('div', 'desk-note', snap === null ? 'Loading…' : 'No tickets repository yet - set one up in the Work panel.'));
      return;
    }
    head.append(textButton('New idea', 'desk-btn desk-btn-primary', 'Capture a new idea', () => deps.newIdea()));
    const model = boardModelOf(snap, deps.runs(), parts);
    const cols = h('div', 'desk-cols');
    for (const column of model.columns) {
      // The last column is done: board 7e has one Done column, "Done this week", below.
      if (!column.terminal) {
        cols.append(columnNode(deps, store, column, unfolded, schedule));
      }
    }
    // One Done column: what sits in the pipeline's last phase (full cards), then the archive of the week.
    const finished = model.columns.find((column) => column.terminal);
    const doneCards = finished?.cards ?? [];
    const doneCount = doneCards.length + model.done.length;
    const done = h('section', 'desk-col desk-col-done');
    done.dataset['phase'] = 'done-this-week';
    done.append(columnHead('Done this week', doneCount, finished === undefined ? '' : columnCostText(finished)));
    const doneBody = h('div', 'desk-col-body');
    const doneOpen = unfolded.has('done-this-week');
    const doneNodes: HTMLElement[] = [
      ...doneCards.map((card) => cardNode(deps, store, card)),
      ...model.done.map((entry) => doneCardNode(entry)),
    ];
    doneBody.append(...(doneOpen ? doneNodes : doneNodes.slice(0, COLUMN_SHOWN)));
    if (doneNodes.length > COLUMN_SHOWN && !doneOpen) {
      doneBody.append(
        moreNode(doneNodes.length - COLUMN_SHOWN, () => {
          unfolded.add('done-this-week');
          schedule();
        }),
      );
    }
    done.append(doneBody);
    cols.append(done);
    // A repaint must not throw the owner back to the first column.
    const before = root.querySelector<HTMLElement>('.desk-cols');
    const left = before?.scrollLeft ?? 0;
    const tops = new Map<string, number>();
    for (const body of root.querySelectorAll<HTMLElement>('.desk-col')) {
      tops.set(body.dataset['phase'] ?? 'done-this-week', body.querySelector<HTMLElement>('.desk-col-body')?.scrollTop ?? 0);
    }
    root.replaceChildren(head, cols);
    cols.scrollLeft = left;
    for (const body of cols.querySelectorAll<HTMLElement>('.desk-col')) {
      const inner = body.querySelector<HTMLElement>('.desk-col-body');
      if (inner !== null) {
        inner.scrollTop = tops.get(body.dataset['phase'] ?? 'done-this-week') ?? 0;
      }
    }
    // A fresh snapshot may have moved a plan on: ask again (the answer repaints).
    if (snap !== askedFor) {
      askedFor = snap;
      asked.clear();
    }
    askPlans();
  };

  const schedule = (): void => {
    if (!disposed && frame === 0) {
      frame = window.requestAnimationFrame(render);
    }
  };
  const offStore = store.subscribe(schedule);
  const offDeps = deps.subscribe(() => {
    // A moved ticket may have left its checkpoint: ask again next time it arrives.
    schedule();
  });
  render();
  return () => {
    disposed = true;
    offStore();
    offDeps();
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    root.remove();
  };
}
