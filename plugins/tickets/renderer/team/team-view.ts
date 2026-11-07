/**
 * The Crew tab (E13-8; design board DeskTeam / 7f): the head with the
 * day's budget and the chain's pause and stop, one card per persona with
 * its state, what it does, and - for a stuck run - Nudge, Hand to Claude
 * Code and Stop (asking first); under the cards the selected persona's
 * detail: a list of panes at the left (Setup, Memory, 1:1) and the pane.
 * Not built yet and left out, as the board has them: the Autopilot chip
 * (the status bar's item), New persona, Edit persona, Talk to 1:1 in the
 * Assistant, Remove from crew, Friction, Notify / Runs after, the slot
 * share and the week / typical-run costs (E12-16, E13-19). Plain DOM over
 * the model in `team-model.ts`.
 */
import type { PersonaView } from '../../shared/remote-protocol';
import type { PersonaMemoryReply, PersonaThreadReply } from '../../shared/remote-protocol';
import { h, textButton, type DeskDeps } from '../desk-deps';
import { NUDGE_TEXT } from '../workers-view';
import {
  poolLabelOf,
  usdBudget,
  teamHeadOf,
  teamModelOf,
  usd,
  type PersonaCardModel,
  type RunRowModel,
  type TeamModel,
} from './team-model';
import type { TeamStore } from './team-store';

/** How long "Stop all" stays armed after the first press. */
const ARM_MS = 4_000;

/** How often the ages and stuck minutes repaint without any event. */
const TICK_MS = 15_000;

type DetailTab = 'Setup' | 'Memory' | '1:1';
const DETAIL_TABS: readonly DetailTab[] = ['Setup', 'Memory', '1:1'];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One of the board's own 16 px glyphs (1.75 stroke, round), from its path data. */
function glyph(paths: readonly string[], rect?: { x: number; y: number; size: number }): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  if (rect !== undefined) {
    const shape = document.createElementNS(SVG_NS, 'rect');
    shape.setAttribute('x', String(rect.x));
    shape.setAttribute('y', String(rect.y));
    shape.setAttribute('width', String(rect.size));
    shape.setAttribute('height', String(rect.size));
    shape.setAttribute('rx', '2');
    svg.append(shape);
  }
  return svg;
}

const GLYPH_BELL = ['M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0'];
const GLYPH_TERMINAL = ['M4 17l6-5-6-5M12 19h8'];
const GLYPH_PAUSE = ['M8 5v14M16 5v14'];
const GLYPH_PLAY = ['M7 5l12 7-12 7z'];

/** The silhouette a card shows while a persona has no picture: the persona colour, a head and shoulders. */
function silhouetteNode(color: string, title: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'desk-silhouette');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', '24');
  bg.setAttribute('height', '24');
  bg.setAttribute('fill', color);
  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '9.5');
  head.setAttribute('r', '4.2');
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M3.5 24c0-5 3.8-8 8.5-8s8.5 3 8.5 8z');
  for (const part of [head, body]) {
    part.setAttribute('fill', 'var(--on-pastel)');
    part.setAttribute('fill-opacity', '0.78');
  }
  svg.append(bg, head, body);
  return svg;
}

function iconButton(label: string, title: string, icon: SVGElement, extra: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', `desk-btn desk-btn-icon ${extra}`);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', label);
  button.append(icon);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** What the card says first: what the persona waits on, is stuck on, or does; the ticket id stays in one piece. */
function headlineNode(card: PersonaCardModel): HTMLElement {
  const node = h('div', 'desk-persona-headline');
  const say = (before: string, ticket: string, after = ''): void => {
    node.append(before);
    node.append(h('span', 'desk-nowrap', ticket));
    if (after !== '') {
      node.append(after);
    }
  };
  if (card.state === 'idle' || card.state === 'paused') {
    node.textContent = card.state === 'idle' ? 'Idle' : 'Paused';
    return node;
  }
  const run = card.runs.find((entry) => entry.stuck) ?? card.runs.find((entry) => entry.waiting) ?? card.runs[0];
  if (run === undefined) {
    node.textContent = card.stateWord;
  } else if (run.stuck) {
    if (run.quietMinutes === null) {
      say('No output on ', run.ticketId);
    } else {
      say(`No output for ${run.quietMinutes} min on `, run.ticketId);
    }
  } else if (run.waiting) {
    say('Waits for your answer on ', run.ticketId);
  } else {
    say('Works on ', run.ticketId, card.runs.length > 1 ? ` +${card.runs.length - 1}` : '');
  }
  return node;
}

/** `Planner · $0.61 today`: the role, then the day's cost when one is known. */
function subLineOf(card: PersonaCardModel): string {
  const cost = card.dailyCost === null ? '' : `${usd(card.dailyCost)} today`;
  return [card.role, cost].filter((part) => part !== '').join(' · ');
}

/** The inline "Stop <name>?" ask under a stuck card's buttons. */
function stopConfirmNode(card: PersonaCardModel, run: RunRowModel, deps: DeskDeps, close: () => void): HTMLElement {
  const box = h('div', 'desk-confirm');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', `Stop ${card.title}?`);
  box.addEventListener('click', (event) => event.stopPropagation());
  const row = h('div', 'desk-confirm-row');
  row.append(
    textButton('Cancel', 'desk-btn', 'Keep the worker running', close),
    textButton('Stop', 'desk-btn desk-btn-danger', 'Stop this run; the branch stays', () => {
      close();
      void deps.mutate('Stopping the worker', () => deps.invoke('fleetStop', { runId: run.runId }));
    }),
  );
  box.append(h('span', undefined, `Stop ${card.title}? The branch stays.`), row);
  return box;
}

function personaCardNode(
  deps: DeskDeps,
  store: TeamStore,
  card: PersonaCardModel,
  selected: boolean,
  stopAsk: boolean,
  select: () => void,
  setStopAsk: (open: boolean) => void,
): HTMLElement {
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
  const title = h('span', 'desk-persona-title');
  title.append(silhouetteNode(card.color, card.title), card.title);
  top.append(title, h('span', 'desk-head-spacer'), h('span', 'desk-persona-dot'), h('span', 'desk-persona-state', card.stateWord));
  node.append(top, headlineNode(card), h('div', 'desk-persona-role', subLineOf(card)));
  const stuck = card.runs.find((run) => run.stuck);
  if (stuck !== undefined) {
    const controls = h('div', 'desk-persona-controls');
    controls.append(
      iconButton('Nudge the worker', 'Nudge the worker', glyph(GLYPH_BELL), '', () =>
        void deps.mutate('Nudging the worker', () => deps.invoke('fleetSend', { runId: stuck.runId, text: NUDGE_TEXT })),
      ),
    );
    if (stuck.provider !== 'claude-code') {
      controls.append(
        iconButton('Hand to Claude Code', 'Hand to Claude Code', glyph(GLYPH_TERMINAL), '', () =>
          void deps.mutate('Handing the ticket to Claude Code', () => deps.invoke('handoffRun', { runId: stuck.runId })).then(() => store.refresh()),
        ),
      );
    }
    controls.append(iconButton('Stop', `Stop ${card.title}? Asks first, the branch stays`, glyph([], { x: 6, y: 6, size: 12 }), '', () => setStopAsk(!stopAsk)));
    node.append(controls);
    if (stopAsk) {
      node.append(stopConfirmNode(card, stuck, deps, () => setStopAsk(false)));
    }
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

/** Setup (board 7f): the model pool in order, and what the persona cost today. */
function setupPane(deps: DeskDeps, store: TeamStore, persona: PersonaView, card: PersonaCardModel, body: HTMLElement): void {
  body.append(h('b', 'desk-pane-title', 'Setup'));
  const columns = h('div', 'desk-setup');
  const poolColumn = h('div', 'desk-setup-col');
  poolColumn.append(h('span', 'desk-label', 'Model pool, in order'));
  const label = poolLabelOf(persona.worker);
  const entries = persona.pool.length > 0 ? persona.pool : persona.model === '' ? [] : [persona.model];
  entries.forEach((model, index) => {
    if (index > 0) {
      poolColumn.append(h('div', 'desk-pool-link', `when ${label} is full`));
    }
    const entry = h('div', `desk-pool${index === 0 ? ' desk-pool-first' : ''}`);
    const text = h('div', 'desk-pool-body');
    const name = h('div', 'desk-pool-name');
    name.append(h('b', undefined, label), h('span', 'desk-pool-model', model));
    text.append(name, h('div', 'desk-pool-note', index === 0 ? 'First choice' : 'Overflow'));
    entry.append(h('span', 'desk-pool-n', String(index + 1)), text);
    poolColumn.append(entry);
  });
  if (entries.length === 0) {
    poolColumn.append(messageNode('No model set.'));
  }
  columns.append(poolColumn);
  body.append(columns);
  if (card.dailyCost !== null) {
    body.append(h('span', 'desk-label', 'Cost'));
    const costs = h('div', 'desk-costs');
    const today = h('div', 'desk-cost');
    today.append(h('span', 'desk-cost-label', 'Today'), h('b', 'desk-cost-value', usd(card.dailyCost)), h('span', 'desk-cost-note', card.runs.length > 0 ? `${card.runs.length} ${card.runs.length === 1 ? 'slot' : 'slots'} running` : 'no run now'));
    costs.append(today);
    body.append(costs);
  }
  const actions = h('div', 'desk-detail-actions');
  actions.append(
    textButton(card.paused ? `Resume ${persona.title}` : `Pause ${persona.title}`, 'desk-btn', card.paused ? 'The dispatcher takes this persona\'s tickets again' : 'The dispatcher holds this persona\'s tickets until it is resumed', () =>
      void deps
        .mutate(card.paused ? 'Resuming the persona' : 'Pausing the persona', () => deps.invoke('personaPause', { persona: persona.id, paused: !card.paused }))
        .then(() => store.refresh()),
    ),
  );
  body.append(actions);
}

function detailNode(deps: DeskDeps, store: TeamStore, card: PersonaCardModel, persona: PersonaView, tab: DetailTab, setTab: (tab: DetailTab) => void): HTMLElement {
  const detail = h('section', 'desk-detail');
  const head = h('div', 'desk-detail-head');
  const avatar = h('span', 'desk-avatar desk-avatar-lg', card.initials);
  avatar.style.setProperty('--persona-color', card.color);
  const name = h('div', 'desk-detail-name');
  name.append(h('span', 'desk-persona-title', card.title), h('span', 'desk-persona-role', card.role));
  head.append(avatar, name);
  const main = h('div', 'desk-detail-main');
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
  main.append(tabs, body);
  detail.append(head, main);
  if (tab === '1:1') {
    threadPane(deps, persona, body);
  } else if (tab === 'Memory') {
    memoryPane(deps, persona, body);
  } else {
    setupPane(deps, store, persona, card, body);
  }
  return detail;
}

// --- the tab -------------------------------------------------------------------

/** The day's cost against the budget as the head writes it (`$4.10 of $15 today` over a bar). */
function budgetNode(model: TeamModel): HTMLElement | null {
  if (model.todayCost === null) {
    return null;
  }
  const node = h('div', 'desk-budget');
  const row = h('div', 'desk-budget-row');
  const cost = h('b', undefined, usd(model.todayCost));
  const rest = h('span');
  rest.append(cost, model.todayBudget === null ? ' today' : ` of ${usdBudget(model.todayBudget)} today`);
  row.append(h('span', undefined, 'Budget'), rest);
  node.append(row);
  if (model.todayBudget !== null && model.todayBudget > 0) {
    const bar = h('span', 'desk-bar');
    const fill = h('span', 'desk-bar-fill');
    fill.style.width = `${Math.min(100, Math.round((model.todayCost / model.todayBudget) * 100))}%`;
    bar.append(fill);
    node.append(bar);
  }
  return node;
}

export function mountTeam(deps: DeskDeps, store: TeamStore, host: HTMLElement): () => void {
  const root = h('div', 'desk-team');
  host.append(root);
  let selected: string | null = null;
  let tab: DetailTab = 'Setup';
  let stopAskFor: string | null = null;
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  let detailKey = '';
  let detail: HTMLElement | null = null;

  const render = (): void => {
    frame = 0;
    const model = teamModelOf(store.personas(), deps.runs(), deps.chain(), deps.titleOf, Date.now());
    // The first persona is selected until the owner picks another: the detail is always there (board 7f).
    if (selected === null || !model.personas.some((entry) => entry.id === selected)) {
      selected = model.personas[0]?.id ?? null;
      detailKey = '';
    }
    const head = h('header', 'desk-head');
    head.append(h('h2', 'desk-h', 'Crew'), h('span', 'desk-head-sub', store.loaded() ? teamHeadOf(model) : 'Loading…'), h('span', 'desk-head-spacer'));
    const budget = budgetNode(model);
    if (budget !== null) {
      head.append(budget);
    }
    head.append(
      iconButton(
        model.halted ? 'Resume all' : 'Pause all after this step',
        model.halted ? 'Let the chain dispatch again' : 'Pause all after this step',
        glyph(model.halted ? GLYPH_PLAY : GLYPH_PAUSE),
        '',
        () => void deps.chainAction('chainMaster', { mode: model.halted ? 'run' : 'halted' }),
      ),
      iconButton(
        'Stop all',
        armed ? 'Click again to abort every live run and halt the chain' : 'Stop all workers? Asks first, branches stay',
        glyph([], { x: 6, y: 6, size: 12 }),
        `desk-btn-peach${armed ? ' desk-btn-armed' : ''}`,
        () => {
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
        },
      ),
    );

    const grid = h('div', 'desk-persona-grid');
    for (const card of model.personas) {
      grid.append(
        personaCardNode(
          deps,
          store,
          card,
          card.id === selected,
          stopAskFor === card.id,
          () => {
            selected = card.id;
            detailKey = '';
            schedule();
          },
          (open) => {
            stopAskFor = open ? card.id : null;
            schedule();
          },
        ),
      );
    }
    if (store.loaded() && model.personas.length === 0) {
      grid.append(messageNode('No personas yet.'));
    }
    if (store.error() !== '') {
      grid.append(messageNode(store.error(), 'error'));
    }

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
            });
    }
    root.replaceChildren(head, grid, ...(detail === null ? [] : [detail]));
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
