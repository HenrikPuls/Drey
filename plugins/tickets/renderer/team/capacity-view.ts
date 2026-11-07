/**
 * The Capacity band (E13-8; design board DeskBoard, bottom): a dock panel
 * in the bottom dock - how many of the pool slots are busy, the pool
 * chips, what each persona is doing right now, today's cost against the
 * budget, Pause all and "Open Team". The same model as the Team tab
 * (`team-model.ts`); the band is the glance, the tab the detail.
 */
import { h, textButton, type DeskDeps } from '../desk-deps';
import type { ChainStatus, RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { isLiveRun, teamModelOf, usd, usdBudget, type PersonaCardModel } from './team-model';
import type { TeamStore } from './team-store';

const TICK_MS = 15_000;

/** The tab identity the band belongs to (board 7e); the Crew tab (7f) shows none. */
const BAND_TABS: readonly string[] = ['board://all'];

/** The band shows only while the Board tab is the active one; in a note, a ticket or the Crew tab it would only be noise. */
export function bandShownFor(activePath: string | null): boolean {
  return activePath !== null && BAND_TABS.includes(activePath);
}

/** What one persona is doing, in a short line: idle, the ticket it works, why it stands. */
export function personaLineOf(card: PersonaCardModel): string {
  if (card.state === 'idle' || card.state === 'paused') {
    return card.state;
  }
  const run = card.runs.find((entry) => entry.stuck) ?? card.runs.find((entry) => entry.waiting) ?? card.runs[0];
  if (run === undefined) {
    return card.stateWord;
  }
  const extra = card.runs.length > 1 ? ` +${card.runs.length - 1}` : '';
  if (run.waiting && !run.stuck) {
    return `${run.ticketId} waits for you${extra}`;
  }
  return `${run.stuck ? 'stuck on' : 'works on'} ${run.ticketId}${extra}`;
}

/** The status the panel header shows (`1 stuck`, `2 running`); null while nothing runs. Reads the runs only, so it works while the panel is closed. */
export function bandStatusOf(runs: readonly RunInfo[]): string | null {
  const live = runs.filter(isLiveRun);
  const stuck = live.filter((run) => run.stuck === true).length;
  if (stuck > 0) {
    return `${stuck} stuck`;
  }
  return live.length > 0 ? `${live.length} running` : null;
}

/** The panel header's status (board 7e): `2 of 5 slots busy` once the pool sizes are known, else what runs. */
export function bandHeaderStatusOf(runs: readonly RunInfo[], chain: ChainStatus | null): string | null {
  const sizes = chain?.poolSize;
  if (sizes !== undefined) {
    const slots = Object.values(sizes).reduce((sum, size) => sum + (typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0), 0);
    if (slots > 0) {
      return `${runs.filter(isLiveRun).length} of ${slots} slots busy`;
    }
  }
  return bandStatusOf(runs);
}

/** A persona's avatar as the band draws it: initials on the persona colour, an orange dot while it is stuck. */
function avatarNode(card: PersonaCardModel): HTMLElement {
  const avatar = h('span', 'desk-cap-avatar', card.initials);
  avatar.style.setProperty('--persona-color', card.color);
  if (card.state === 'stuck') {
    const dot = h('span', 'desk-cap-stuckdot');
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Stuck');
    avatar.append(dot);
  }
  return avatar;
}

/** Slot dots: one filled per live run (the persona's slot total needs an engine count, E13-19). */
function slotDots(card: PersonaCardModel): HTMLElement {
  const dots = h('span', 'desk-cap-slots');
  const total = Math.max(1, card.runs.length);
  for (let i = 0; i < total; i++) {
    dots.append(h('span', `desk-cap-slot${i < card.runs.length ? ' desk-cap-slot-busy' : ''}`));
  }
  return dots;
}

export function mountCapacity(deps: DeskDeps, store: TeamStore, host: HTMLElement, openTeam: () => void): () => void {
  const root = h('div', 'desk-capacity');
  host.append(root);
  let frame = 0;

  const render = (): void => {
    frame = 0;
    root.hidden = !bandShownFor(deps.api.documents.active()?.path ?? null);
    if (root.hidden) {
      return;
    }
    const model = teamModelOf(store.personas(), deps.runs(), deps.chain(), deps.titleOf, Date.now());
    const nodes: HTMLElement[] = [];
    for (const card of model.personas) {
      const person = h('button', `desk-cap-person desk-cap-${card.state}`);
      person.type = 'button';
      person.dataset['persona'] = card.id;
      person.title = `${card.title}: ${personaLineOf(card)}`;
      person.addEventListener('click', openTeam);
      const text = h('span', 'desk-cap-text');
      const nameLine = h('span', 'desk-cap-nameline');
      nameLine.append(h('span', 'desk-cap-name', card.title), slotDots(card));
      text.append(nameLine, h('span', 'desk-cap-line', personaLineOf(card)));
      person.append(avatarNode(card), text);
      nodes.push(person);
    }
    if (store.loaded() && model.personas.length === 0) {
      nodes.push(h('span', 'desk-cap-line', 'No personas yet'));
    }
    nodes.push(h('span', 'desk-cap-sep'));
    if (model.todayCost !== null) {
      const budget = h('div', 'desk-cap-budget');
      const row = h('div', 'desk-cap-budget-row');
      row.append(
        h('span', 'desk-cap-budget-label', 'Budget'),
        h('span', 'desk-cap-today', `${usd(model.todayCost)}${model.todayBudget === null ? '' : ` of ${usdBudget(model.todayBudget)}`} today`),
      );
      budget.append(row);
      if (model.todayBudget !== null && model.todayBudget > 0) {
        const bar = h('span', 'desk-bar');
        const fill = h('span', 'desk-bar-fill');
        fill.style.width = `${Math.min(100, Math.round((model.todayCost / model.todayBudget) * 100))}%`;
        bar.append(fill);
        budget.append(bar);
      }
      nodes.push(budget);
    }
    nodes.push(textButton('Crew', 'desk-btn desk-cap-crew', 'Open the Crew tab', openTeam));
    root.replaceChildren(...nodes);
  };

  const schedule = (): void => {
    if (frame === 0) {
      frame = window.requestAnimationFrame(render);
    }
  };
  const offStore = store.subscribe(schedule);
  const offDeps = deps.subscribe(schedule);
  const offDocs = deps.api.documents.onChange((event) => {
    if (event.type === 'active-changed' || event.type === 'docs-changed') {
      schedule();
    }
  });
  const tick = setInterval(schedule, TICK_MS);
  render();
  return () => {
    offStore();
    offDeps();
    offDocs();
    clearInterval(tick);
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    root.remove();
  };
}
