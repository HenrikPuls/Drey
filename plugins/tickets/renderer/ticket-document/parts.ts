// i18n: catalog
/**
 * The Parts block in the ticket (E13-10, E12-17, board 7c): the plan's `### Parts`
 * drawn as cards with a persona, a state and an estimate each. The engine's plan
 * routes are the contract (E10-4): a move, a persona pick or a delete is one
 * `planPartsEdit`, no direct file write. The release is the decision card's
 * (canvas decisions 16, 28): the block only links to it.
 */
import type { RunEstimate } from '../../../../packages/tickets-engine/src/core/estimate';
import type { PlanPartsEdit, PlanPartsReply } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import type { I18n } from '../../../../shared/i18n/types';
import { avatarNode, decisionLinkNode } from './dom';
import { partsViewOf, type PartView, type PartsView } from './parts-model';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

export interface PartsStoreDeps {
  readonly i18n: I18n;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  /** An answer arrived: the open documents draw again. */
  readonly changed: () => void;
}

export interface PartsStore {
  /** Asks the engine when `text` (the chapter as it stands) differs from what was asked last. */
  want(id: string, text: string): void;
  /** The block's words, or null until the cards arrived or when the engine refused. */
  view(id: string): PartsView | null;
  /** One list edit; resolves with the refusal's words, or null when it went through. */
  edit(id: string, edit: PlanPartsEdit): Promise<string | null>;
}

export function createPartsStore(deps: PartsStoreDeps): PartsStore {
  const replies = new Map<string, Extract<PlanPartsReply, { ok: true }>>();
  const asked = new Map<string, string>();
  const estimates = new Map<string, RunEstimate | null>();
  const estimateAsked = new Set<string>();

  const estimateOf = (gate: string, persona: string): RunEstimate | null => {
    const key = `${gate}|${persona}`;
    if (!estimateAsked.has(key)) {
      estimateAsked.add(key);
      void deps
        .invoke('estimate', { gate, persona })
        .then((reply) => {
          estimates.set(key, (reply as { estimate?: RunEstimate | null } | null)?.estimate ?? null);
          deps.changed();
        })
        .catch(() => estimateAsked.delete(key));
    }
    return estimates.get(key) ?? null;
  };

  const load = (id: string): void => {
    void deps
      .invoke('planParts', { id })
      .then((reply) => {
        const parts = reply as PlanPartsReply | null;
        if (parts?.ok === true) {
          replies.set(id, parts);
        } else {
          replies.delete(id);
        }
        deps.changed();
      })
      .catch(() => asked.delete(id));
  };

  return {
    want: (id, text) => {
      if (asked.get(id) !== text) {
        asked.set(id, text);
        load(id);
      }
    },
    view: (id) => {
      const reply = replies.get(id);
      return reply === undefined ? null : partsViewOf(deps.i18n, reply, estimateOf);
    },
    edit: async (id, edit) => {
      const reply = (await deps.invoke('planPartsEdit', { id, ...edit })) as { ok?: boolean; error?: string } | null;
      load(id);
      return reply?.ok === true ? null : (reply?.error ?? '');
    },
  };
}

export interface PartsNodeDeps {
  readonly i18n: I18n;
  readonly icon: (name: string, size?: number) => SVGElement;
  readonly edit: (edit: PlanPartsEdit) => void;
  readonly onFlow: (part: number | null) => void;
  /** "Ask Mission Control to change the split": the ticket's conversation. */
  readonly onAsk: () => void;
  /** A decision is waiting: the link to the card is shown. */
  readonly decide: boolean;
  /** The chain's working steps: what the foot's flow line names. */
  readonly flowSteps: readonly string[];
}

interface MenuRow {
  readonly label: string;
  readonly disabled?: boolean;
  /** Returns false to keep the menu open (the first press of a delete). */
  readonly run: (row: HTMLButtonElement) => boolean | void;
}

/** A small menu under its button; the board's `tickets-menu` look, closed by any press outside. */
function openMenu(anchor: HTMLElement, rows: readonly MenuRow[]): void {
  const menu = el('div', 'tickets-menu tickets-parts-menu');
  menu.setAttribute('role', 'menu');
  const close = (): void => {
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
  };
  const outside = (event: Event): void => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  };
  for (const row of rows) {
    const button = el('button', 'tickets-menu-item', row.label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.disabled = row.disabled === true;
    button.addEventListener('click', () => {
      if (row.run(button) !== false) {
        close();
      }
    });
    menu.append(button);
  }
  const box = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${box.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
  document.body.append(menu);
  window.addEventListener('mousedown', outside, true);
}

function partRow(deps: PartsNodeDeps, view: PartsView, part: PartView): HTMLElement {
  const { i18n } = deps;
  const n = part.index + 1;
  const row = el('div', `tickets-part${part.locked ? ' is-locked' : ''}`);
  row.dataset['part'] = String(part.index);

  const grip = el('button', 'tickets-part-grip');
  grip.type = 'button';
  grip.title = i18n.t('ticket.parts.move', { n });
  grip.setAttribute('aria-label', grip.title);
  grip.append(deps.icon('grip-vertical', 14));
  grip.disabled = part.locked;
  if (!part.locked) {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/x-drey-part', String(part.index));
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer?.getData('text/x-drey-part'));
      if (Number.isInteger(from) && from !== part.index) {
        deps.edit({ op: 'move', from, to: part.index });
      }
    });
  }

  const body = el('div', 'tickets-part-body');
  body.append(el('div', 'tickets-part-title', part.title));
  if (part.line !== '') {
    body.append(el('div', 'tickets-part-line', part.line));
  }

  const state = el('span', 'tickets-part-state');
  state.append(el('span', undefined, part.stateGlyph), document.createTextNode(part.stateLabel));

  const persona = el('button', 'tickets-part-persona');
  persona.type = 'button';
  persona.setAttribute('aria-label', i18n.t('ticket.parts.persona', { n }));
  persona.disabled = part.locked;
  persona.append(
    avatarNode(part.personaColor, part.personaName, 20),
    el('span', 'tickets-part-persona-name', part.personaName),
    deps.icon('chevron-down', 12),
  );
  persona.addEventListener('click', () => {
    openMenu(
      persona,
      view.personas.map((option) => ({
        label: option.title,
        run: () => deps.edit({ op: 'persona', index: part.index, persona: option.id }),
      })),
    );
  });

  const estimate = el('div', 'tickets-part-estimate');
  if (part.estimate !== '') {
    estimate.append(document.createTextNode(part.estimate), ' ');
  }
  estimate.append(el('span', 'tickets-part-basis', part.basis));

  const more = el('button', 'tickets-part-more');
  more.type = 'button';
  more.title = i18n.t('ticket.parts.actions', { n });
  more.setAttribute('aria-label', more.title);
  more.append(deps.icon('more-horizontal', 14));
  more.addEventListener('click', () => {
    let armed = false;
    const first = part.index === 0;
    const last = part.index === view.parts.length - 1;
    openMenu(more, [
      {
        label: i18n.t('ticket.parts.move_up'),
        disabled: part.locked || first,
        run: () => deps.edit({ op: 'move', from: part.index, to: part.index - 1 }),
      },
      {
        label: i18n.t('ticket.parts.move_down'),
        disabled: part.locked || last,
        run: () => deps.edit({ op: 'move', from: part.index, to: part.index + 1 }),
      },
      { label: i18n.t('ticket.parts.change_flow'), run: () => deps.onFlow(part.index) },
      {
        label: i18n.t('ticket.parts.delete'),
        disabled: part.locked,
        run: (button) => {
          if (!armed) {
            armed = true;
            button.textContent = i18n.t('ticket.parts.delete_confirm');
            return false;
          }
          deps.edit({ op: 'delete', index: part.index });
          return true;
        },
      },
    ]);
  });

  row.append(grip, el('span', 'tickets-part-label', part.label), body, state, persona, estimate, more);
  return row;
}

/** The block of board 7c and the rule line under it. */
export function partsNode(deps: PartsNodeDeps, view: PartsView): HTMLElement {
  const { i18n } = deps;
  const root = el('section', 'tickets-parts-host');
  root.contentEditable = 'false';
  const block = el('div', 'tickets-parts');

  const head = el('div', 'tickets-parts-head');
  head.append(el('b', 'tickets-parts-title', i18n.t('ticket.parts.title')), el('span', 'tickets-parts-count', view.count), el('span', 'tickets-card-spacer'));
  if (view.total !== '') {
    head.append(el('span', 'tickets-parts-muted', i18n.t('ticket.parts.typical_total')), el('b', undefined, view.total));
  }
  block.append(head);

  for (const part of view.parts) {
    block.append(partRow(deps, view, part));
  }

  const foot = el('div', 'tickets-parts-foot');
  const change = el('a', 'tickets-parts-link', `${i18n.t('ticket.parts.change_flow')} ›`);
  change.href = '#';
  change.addEventListener('click', (event) => {
    event.preventDefault();
    deps.onFlow(null);
  });
  const ask = el('button', 'tickets-doc-btn is-quiet', i18n.t('ticket.parts.ask_split'));
  ask.type = 'button';
  ask.addEventListener('click', deps.onAsk);
  const flow = i18n.t(view.edited ? 'ticket.parts.flow_custom' : 'ticket.parts.flow_standard', { steps: deps.flowSteps.join(', ') });
  foot.append(el('span', 'tickets-parts-flow', flow), change, el('span', 'tickets-card-spacer'), ask);
  if (deps.decide) {
    foot.append(decisionLinkNode(i18n, view.ticket, deps.onAsk));
  }
  block.append(foot);

  root.append(block, el('div', 'tickets-parts-rule', i18n.t('ticket.parts.rule')));
  return root;
}
