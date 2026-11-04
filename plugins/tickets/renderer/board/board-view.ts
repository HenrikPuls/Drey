/**
 * The Board tab (E13-8; design board DeskBoard): the pipeline as columns,
 * one card per ticket - id, kind, persona, title, cost - the parts of a
 * ticket under it (released parts are tickets with `parent:`, the plan's
 * unreleased parts come from `planParts`), the cost of each column in its
 * head and "Done this week" last. Reads the shared board store; a card
 * opens the ticket page. Plain DOM over `board-model.ts`.
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

function personaChip(store: TeamStore, id: string | null): HTMLElement | null {
  if (id === null || id === '') {
    return null;
  }
  const chip = h('span', 'desk-persona-chip', store.nameOf(id));
  chip.title = `Persona: ${store.nameOf(id)}`;
  return chip;
}

function costNode(cost: number | null): HTMLElement | null {
  return cost === null ? null : h('span', 'desk-card-cost', usd(cost));
}

function partNode(deps: DeskDeps, store: TeamStore, part: BoardPartModel): HTMLElement {
  const row = h('div', `desk-part${part.card === null ? ' desk-part-plan' : ''}`);
  row.append(h('span', 'desk-part-handle', part.handle), h('span', 'desk-part-title', part.title));
  const chip = personaChip(store, part.personaId);
  if (chip !== null) {
    row.append(chip);
  }
  row.append(h('span', 'desk-part-state', part.state));
  const cost = costNode(part.cost);
  if (cost !== null) {
    row.append(cost);
  }
  const target = part.card;
  if (target !== null) {
    row.classList.add('desk-part-open');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', () => deps.openTicket(target));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        deps.openTicket(target);
      }
    });
  }
  return row;
}

function cardNode(deps: DeskDeps, store: TeamStore, card: BoardCardModel): HTMLElement {
  const node = h('article', `desk-card${card.running ? ' desk-card-running' : ''}`);
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
  const chip = personaChip(store, card.personaId);
  if (chip !== null) {
    top.append(chip);
  }
  const cost = costNode(card.cost);
  if (cost !== null) {
    top.append(cost);
  }
  node.append(top, h('div', 'desk-card-title', card.title));
  if (card.line !== '') {
    node.append(h('div', 'desk-card-line', card.line));
  }
  if (card.parts.length > 0) {
    const parts = h('div', 'desk-parts');
    for (const part of card.parts) {
      parts.append(partNode(deps, store, part));
    }
    node.append(parts);
  }
  return node;
}

function columnNode(deps: DeskDeps, store: TeamStore, column: BoardColumnModel): HTMLElement {
  const node = h('section', 'desk-col');
  node.dataset['phase'] = column.id;
  const head = h('div', 'desk-col-head');
  head.append(h('span', 'desk-col-title', column.title), h('span', 'desk-col-count', String(column.cards.length)));
  const cost = columnCostText(column);
  if (cost !== '') {
    const costNodeEl = h('span', 'desk-col-cost', cost);
    costNodeEl.title = 'Settled cost of the tickets in this column';
    head.append(costNodeEl);
  }
  if (column.first) {
    head.append(textButton('New idea', 'desk-btn desk-btn-small desk-col-new', 'Capture a new idea', () => deps.newIdea()));
  }
  node.append(head);
  const body = h('div', 'desk-col-body');
  for (const card of column.cards) {
    body.append(cardNode(deps, store, card));
  }
  if (column.cards.length === 0) {
    body.append(h('div', 'desk-note', 'Empty'));
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
    const title = h('div', 'desk-head-title');
    title.append(h('h2', 'desk-h', 'Board'));
    if (snap === null || snap.vaultId === null) {
      head.append(title);
      root.replaceChildren(head, h('div', 'desk-note', snap === null ? 'Loading…' : 'No tickets repository yet - set one up in the Work panel.'));
      return;
    }
    const model = boardModelOf(snap, deps.runs(), parts);
    const running = deps.runs().filter((run) => ['starting', 'running', 'stopping', 'detached'].includes(run.state)).length;
    title.append(h('span', 'desk-head-sub', `${model.total} tickets${running > 0 ? ` · ${running} running` : ''}`));
    head.append(title);
    const cols = h('div', 'desk-cols');
    for (const column of model.columns) {
      cols.append(columnNode(deps, store, column));
    }
    if (model.done.length > 0) {
      const done = h('section', 'desk-col desk-col-done');
      done.dataset['phase'] = 'done-this-week';
      const doneHead = h('div', 'desk-col-head');
      doneHead.append(h('span', 'desk-col-title', 'Done this week'), h('span', 'desk-col-count', String(model.done.length)));
      const body = h('div', 'desk-col-body');
      for (const entry of model.done) {
        const row = h('div', 'desk-done');
        row.append(h('span', 'desk-card-id', entry.id), h('span', 'desk-done-title', entry.title));
        body.append(row);
      }
      done.append(doneHead, body);
      cols.append(done);
    }
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
