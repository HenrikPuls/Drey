/**
 * The Team tab (E13-8; design board DeskTeam, state words and run rows
 * from E12-4): one card per persona with its state, the day's cost
 * against its budget and one row per live run - a flagged (stuck) run
 * turns amber and offers Nudge, Hand to Claude Code and Stop. Above the
 * cards: today's cost, the capacity chips, Pause all and Stop all. A
 * card opens the persona's detail beside the grid: the 1:1 (coaching
 * thread), Memory and Setup. Plain DOM over the model in `team-model.ts`.
 */
import type { PersonaView } from '../../shared/remote-protocol';
import type { PersonaMemoryReply, PersonaThreadReply } from '../../shared/remote-protocol';
import type { TicketCard } from '../../shared/tickets';
import { h, textButton, type DeskDeps } from '../desk-deps';
import { NUDGE_TEXT } from '../workers-view';
import {
  teamHeadOf,
  teamModelOf,
  usd,
  type CapacityChip,
  type PersonaCardModel,
  type RunRowModel,
  type TeamModel,
} from './team-model';
import type { TeamStore } from './team-store';

/** How long "Stop all" stays armed after the first press. */
const ARM_MS = 4_000;

/** How often the ages and stuck minutes repaint without any event. */
const TICK_MS = 15_000;

type DetailTab = '1:1' | 'Memory' | 'Setup';
const DETAIL_TABS: readonly DetailTab[] = ['1:1', 'Memory', 'Setup'];

function cardOf(deps: DeskDeps, ticketId: string): TicketCard | null {
  for (const column of deps.snapshot()?.columns ?? []) {
    const found = column.tickets.find((ticket) => ticket.id === ticketId);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

function avatarNode(card: Pick<PersonaCardModel, 'initials' | 'color'>, size: 'sm' | 'lg' = 'sm'): HTMLElement {
  const avatar = h('span', `desk-avatar desk-avatar-${size}`, card.initials);
  avatar.style.setProperty('--persona-color', card.color);
  return avatar;
}

/** The capacity chips (`Local 2/2`), shared by the tab and the band. */
export function capacityChipsNode(chips: readonly CapacityChip[]): HTMLElement {
  const row = h('div', 'desk-chips');
  for (const chip of chips) {
    const node = h('span', `desk-chip${chip.running >= chip.size && chip.size > 0 ? ' desk-chip-full' : ''}`, `${chip.label} ${chip.running}/${chip.size}`);
    node.title = `${chip.label}: ${chip.running} of ${chip.size} parallel runs`;
    row.append(node);
  }
  return row;
}

/** One live run under a card. */
function runRowNode(deps: DeskDeps, store: TeamStore, run: RunRowModel): HTMLElement {
  const row = h('div', `desk-run${run.stuck ? ' desk-run-stuck' : ''}`);
  const ticket = cardOf(deps, run.ticketId);
  const head = h('div', 'desk-run-head');
  const link = h('button', 'desk-run-ticket', run.title === '' ? run.ticketId : `${run.ticketId} ${run.title}`);
  link.type = 'button';
  link.title = 'Open the ticket';
  link.addEventListener('click', (event) => {
    event.stopPropagation();
    if (ticket !== null) {
      deps.openTicket(ticket);
    }
  });
  head.append(link, h('span', 'desk-run-age', run.age));
  row.append(head);
  if (run.stuck) {
    row.append(h('div', 'desk-run-stuckline', run.stuckLine));
    const controls = h('div', 'desk-run-controls');
    // A press on a control must not also select the card behind it.
    controls.addEventListener('click', (event) => event.stopPropagation());
    controls.append(
      textButton('Nudge', 'desk-btn', 'Ask the worker to say what it is doing and carry on', () =>
        void deps.mutate('Nudging the worker', () => deps.invoke('fleetSend', { runId: run.runId, text: NUDGE_TEXT })),
      ),
    );
    if (run.provider !== 'claude-code') {
      controls.append(
        textButton('Hand to Claude Code', 'desk-btn', 'Stop this run and start the ticket again on Claude Code', () =>
          void deps.mutate('Handing the ticket to Claude Code', () => deps.invoke('handoffRun', { runId: run.runId })).then(() => store.refresh()),
        ),
      );
    }
    controls.append(
      textButton('Stop', 'desk-btn desk-btn-danger', 'Stop this run', () =>
        void deps.mutate('Stopping the worker', () => deps.invoke('fleetStop', { runId: run.runId })),
      ),
    );
    row.append(controls);
  } else if (run.activity !== '') {
    row.append(h('div', 'desk-run-activity', run.activity));
  }
  return row;
}

function personaCardNode(deps: DeskDeps, store: TeamStore, card: PersonaCardModel, selected: boolean, select: () => void): HTMLElement {
  const node = h('article', `desk-persona desk-persona-${card.state}${selected ? ' desk-persona-selected' : ''}`);
  node.dataset['persona'] = card.id;
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${card.title}, ${card.stateWord}`);
  node.style.setProperty('--persona-color', card.color);
  node.addEventListener('click', select);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === node) {
      event.preventDefault();
      select();
    }
  });
  const top = h('div', 'desk-persona-top');
  const name = h('div', 'desk-persona-name');
  name.append(h('span', 'desk-persona-title', card.title), h('span', 'desk-persona-state', card.stateWord));
  top.append(avatarNode(card), name);
  node.append(top);
  const phases = card.phases.length > 0 ? ` · ${card.phases.join(', ')}` : '';
  node.append(h('div', 'desk-persona-role', `${card.role}${phases}`));
  for (const run of card.runs) {
    node.append(runRowNode(deps, store, run));
  }
  if (card.costLine !== '') {
    const foot = h('div', 'desk-persona-foot');
    foot.append(h('span', `desk-persona-cost${card.overBudget ? ' desk-over' : ''}`, card.costLine));
    if (card.budgetPct !== null) {
      const bar = h('span', 'desk-bar');
      const fill = h('span', 'desk-bar-fill');
      fill.style.width = `${card.budgetPct}%`;
      bar.append(fill);
      foot.append(bar);
    }
    node.append(foot);
  }
  return node;
}

// --- the persona detail -------------------------------------------------------

function messageNode(text: string, kind: 'empty' | 'error' = 'empty'): HTMLElement {
  return h('div', kind === 'error' ? 'desk-note desk-note-error' : 'desk-note', text);
}

function threadPane(deps: DeskDeps, persona: PersonaView, body: HTMLElement): void {
  const list = h('div', 'desk-thread');
  const input = h('textarea', 'desk-input');
  input.rows = 3;
  input.setAttribute('aria-label', `Message to ${persona.title}`);
  const send = textButton('Send', 'desk-btn desk-btn-primary', 'Add the message to the coaching thread', () => void submit());
  const paint = (reply: PersonaThreadReply): void => {
    list.replaceChildren();
    if (!reply.ok) {
      list.append(messageNode(reply.error, 'error'));
      return;
    }
    if (reply.messages.length === 0) {
      list.append(messageNode('No messages yet.'));
    }
    for (const message of reply.messages) {
      const bubble = h('div', 'desk-msg');
      bubble.append(h('div', 'desk-msg-text', message.text), h('div', 'desk-msg-at', message.at.slice(0, 16).replace('T', ' ')));
      list.append(bubble);
    }
    list.scrollTop = list.scrollHeight;
  };
  const submit = async (): Promise<void> => {
    const text = input.value.trim();
    if (text === '') {
      return;
    }
    send.disabled = true;
    try {
      paint((await deps.invoke('personaThreadAppend', { persona: persona.id, text })) as PersonaThreadReply);
      input.value = '';
    } catch (error) {
      list.append(messageNode(error instanceof Error ? error.message : String(error), 'error'));
    } finally {
      send.disabled = false;
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  });
  const composer = h('div', 'desk-composer');
  composer.append(input, send);
  body.append(list, composer);
  void deps
    .invoke('personaThread', { persona: persona.id })
    .then((reply) => paint(reply as PersonaThreadReply))
    .catch((error: unknown) => paint({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

function memoryPane(deps: DeskDeps, persona: PersonaView, body: HTMLElement): void {
  const list = h('div', 'desk-memory');
  const input = h('input', 'desk-input desk-input-line');
  input.type = 'text';
  input.setAttribute('aria-label', `Teach ${persona.title}`);
  const paint = (reply: PersonaMemoryReply): void => {
    list.replaceChildren();
    if (!reply.ok) {
      list.append(messageNode(reply.error, 'error'));
      return;
    }
    if (reply.entries.length === 0) {
      list.append(messageNode('No memory yet.'));
    }
    reply.entries.forEach((entry, index) => {
      const row = h('div', `desk-memory-row${entry.pinned ? ' desk-memory-pinned' : ''}`);
      const pin = textButton(entry.pinned ? 'Pinned' : 'Pin', 'desk-btn desk-btn-small', entry.pinned ? 'Unpin this entry' : 'Pin this entry - it always rides along', () =>
        void act('personaMemoryPin', { persona: persona.id, index, pinned: !entry.pinned }),
      );
      row.append(h('span', 'desk-memory-text', entry.text), pin);
      list.append(row);
    });
  };
  const act = async (method: string, payload: unknown): Promise<void> => {
    try {
      paint((await deps.invoke(method, payload)) as PersonaMemoryReply);
    } catch (error) {
      list.append(messageNode(error instanceof Error ? error.message : String(error), 'error'));
    }
  };
  const add = textButton('Add', 'desk-btn desk-btn-primary', 'Teach the persona this', () => {
    const text = input.value.trim();
    if (text !== '') {
      input.value = '';
      void act('personaMemoryAppend', { persona: persona.id, text });
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add.click();
    }
  });
  const composer = h('div', 'desk-composer desk-composer-line');
  composer.append(input, add);
  body.append(list, composer);
  void act('personaMemory', { persona: persona.id });
}

function setupPane(deps: DeskDeps, store: TeamStore, persona: PersonaView, card: PersonaCardModel, body: HTMLElement): void {
  const rows: [string, string][] = [
    ['Worker', persona.worker],
    ['Model', persona.model],
    ['Pool', persona.pool.length === 0 ? 'none' : persona.pool.map((entry, index) => `${index + 1} · ${entry}`).join('\n')],
    ['Runs in', card.phases.length === 0 ? 'no phase' : card.phases.join(', ')],
    ['Today', card.costLine === '' ? 'no cost yet' : card.costLine],
  ];
  const grid = h('dl', 'desk-setup');
  for (const [label, value] of rows) {
    const term = h('dt', undefined, label);
    const desc = h('dd', undefined, value);
    desc.style.whiteSpace = 'pre-line';
    grid.append(term, desc);
  }
  body.append(grid);
  const pause = textButton(card.paused ? `Resume ${persona.title}` : `Pause ${persona.title}`, 'desk-btn', card.paused ? 'The dispatcher takes this persona\'s tickets again' : 'The dispatcher holds this persona\'s tickets until it is resumed', () =>
    void deps
      .mutate(card.paused ? 'Resuming the persona' : 'Pausing the persona', () => deps.invoke('personaPause', { persona: persona.id, paused: !card.paused }))
      .then(() => store.refresh()),
  );
  body.append(pause);
}

function detailNode(deps: DeskDeps, store: TeamStore, card: PersonaCardModel, persona: PersonaView, tab: DetailTab, setTab: (tab: DetailTab) => void, close: () => void): HTMLElement {
  const aside = h('aside', 'desk-detail');
  const head = h('div', 'desk-detail-head');
  const name = h('div', 'desk-detail-name');
  name.append(h('span', 'desk-persona-title', card.title), h('span', 'desk-persona-role', card.role));
  const closeButton = h('button', 'icon-btn desk-detail-close');
  closeButton.type = 'button';
  closeButton.title = 'Close the detail';
  closeButton.setAttribute('aria-label', 'Close the detail');
  closeButton.append(deps.api.ui.icon('x', 14));
  closeButton.addEventListener('click', close);
  head.append(avatarNode(card, 'lg'), name, closeButton);
  const tabs = h('div', 'desk-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const entry of DETAIL_TABS) {
    const button = h('button', `desk-tab${entry === tab ? ' desk-tab-on' : ''}`, entry);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(entry === tab));
    button.addEventListener('click', () => setTab(entry));
    tabs.append(button);
  }
  const body = h('div', 'desk-detail-body');
  aside.append(head, tabs, body);
  if (tab === '1:1') {
    threadPane(deps, persona, body);
  } else if (tab === 'Memory') {
    memoryPane(deps, persona, body);
  } else {
    setupPane(deps, store, persona, card, body);
  }
  return aside;
}

// --- the tab -------------------------------------------------------------------

/** Today's cost against the budget as the head writes it (`Today $4.10 of $15`). */
function todayNode(model: TeamModel): HTMLElement | null {
  if (model.todayCost === null) {
    return null;
  }
  const node = h('div', 'desk-today');
  node.append(h('span', 'desk-today-label', 'Today'), h('span', 'desk-today-cost', usd(model.todayCost)));
  if (model.todayBudget !== null) {
    node.append(h('span', 'desk-today-budget', `of ${usd(model.todayBudget)}`));
  }
  return node;
}

export function mountTeam(deps: DeskDeps, store: TeamStore, host: HTMLElement): () => void {
  const root = h('div', 'desk-team');
  host.append(root);
  let selected: string | null = null;
  let tab: DetailTab = '1:1';
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  let detailKey = '';
  let detail: HTMLElement | null = null;

  const render = (): void => {
    frame = 0;
    const model = teamModelOf(store.personas(), deps.runs(), deps.chain(), deps.titleOf, Date.now());
    const head = h('header', 'desk-head');
    const title = h('div', 'desk-head-title');
    title.append(h('h2', 'desk-h', 'Crew'), h('span', 'desk-head-sub', store.loaded() ? teamHeadOf(model) : 'Loading…'));
    const controls = h('div', 'desk-head-controls');
    const today = todayNode(model);
    if (today !== null) {
      controls.append(today);
    }
    controls.append(
      textButton(model.halted ? 'Resume all' : 'Pause all', 'desk-btn', model.halted ? 'Let the chain dispatch again' : 'Let running work finish and start nothing new', () =>
        void deps.chainAction('chainMaster', { mode: model.halted ? 'run' : 'halted' }),
      ),
      textButton(armed ? 'Stop all — click again' : 'Stop all', `desk-btn desk-btn-danger${armed ? ' desk-btn-armed' : ''}`, 'Abort every live run and halt the chain', () => {
        if (!armed) {
          armed = true;
          armTimer = setTimeout(() => {
            armed = false;
            armTimer = null;
            schedule();
          }, ARM_MS);
          schedule();
          return;
        }
        armed = false;
        if (armTimer !== null) {
          clearTimeout(armTimer);
          armTimer = null;
        }
        void deps.chainAction('chainAbort', {});
      }),
    );
    head.append(title, controls);

    const grid = h('div', 'desk-persona-grid');
    for (const card of model.personas) {
      grid.append(personaCardNode(deps, store, card, card.id === selected, () => {
        selected = selected === card.id ? null : card.id;
        detailKey = '';
        schedule();
      }));
    }
    if (store.loaded() && model.personas.length === 0) {
      grid.append(messageNode('No personas yet.'));
    }
    if (store.error() !== '') {
      grid.append(messageNode(store.error(), 'error'));
    }
    const main = h('div', 'desk-team-main');
    main.append(capacityChipsNode(model.capacity), grid);

    // The detail keeps its own DOM across fleet repaints (a typed message survives).
    const persona = selected === null ? undefined : store.personas().find((entry) => entry.id === selected);
    const card = model.personas.find((entry) => entry.id === selected);
    const key = persona === undefined ? '' : `${persona.id}|${tab}|${card?.paused === true}`;
    if (key !== detailKey) {
      detailKey = key;
      detail =
        persona === undefined || card === undefined
          ? null
          : detailNode(deps, store, card, persona, tab, (next) => {
              tab = next;
              schedule();
            }, () => {
              selected = null;
              schedule();
            });
    }
    const body = h('div', 'desk-team-body');
    body.append(main);
    if (detail !== null) {
      body.append(detail);
    }
    // A repaint keeps the cards' scroll position.
    const scrolled = root.querySelector<HTMLElement>('.desk-team-main')?.scrollTop ?? 0;
    root.replaceChildren(head, body);
    main.scrollTop = scrolled;
  };

  const schedule = (): void => {
    if (frame === 0) {
      frame = window.requestAnimationFrame(render);
    }
  };
  const offStore = store.subscribe(schedule);
  const offDeps = deps.subscribe(schedule);
  const tick = setInterval(schedule, TICK_MS);
  render();
  return () => {
    offStore();
    offDeps();
    clearInterval(tick);
    if (armTimer !== null) {
      clearTimeout(armTimer);
    }
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    root.remove();
  };
}
