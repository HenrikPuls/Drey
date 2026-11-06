/**
 * The Capacity band (E13-8; design board DeskBoard, bottom): a dock panel
 * in the bottom dock - how many of the pool slots are busy, the pool
 * chips, what each persona is doing right now, today's cost against the
 * budget, Pause all and "Open Team". The same model as the Team tab
 * (`team-model.ts`); the band is the glance, the tab the detail.
 */
import { h, textButton, type DeskDeps } from '../desk-deps';
import { capacityChipsNode } from './team-view';
import type { RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { isLiveRun, slotsLineOf, teamModelOf, usd, type PersonaCardModel } from './team-model';
import type { TeamStore } from './team-store';

const TICK_MS = 15_000;

/** The tab identities the band belongs to (board 7e): the Board and the Crew. */
const BAND_TABS: readonly string[] = ['board://all', 'team://all'];

/** The band shows only while the Board or Crew tab is the active one; in a note or a ticket it would only be noise. */
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
  const why = run.stuck ? 'stuck on' : run.waiting ? 'waits for you on' : 'works on';
  return `${why} ${run.ticketId}${extra}`;
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
    const lead = h('div', 'desk-cap-lead');
    const slots = slotsLineOf(model);
    lead.append(h('span', 'desk-cap-slots', slots === '' ? 'Capacity' : slots));
    if (model.capacity.length > 0) {
      lead.append(capacityChipsNode(model.capacity));
    }
    const people = h('div', 'desk-cap-people');
    for (const card of model.personas) {
      const person = h('div', `desk-cap-person desk-cap-${card.state}`);
      person.style.setProperty('--persona-color', card.color);
      person.append(h('span', 'desk-cap-dot'), h('span', 'desk-cap-name', card.title), h('span', 'desk-cap-line', personaLineOf(card)));
      people.append(person);
    }
    if (store.loaded() && model.personas.length === 0) {
      people.append(h('span', 'desk-cap-line', 'No personas yet'));
    }
    const tail = h('div', 'desk-cap-tail');
    if (model.todayCost !== null) {
      tail.append(h('span', 'desk-cap-today', `Today ${usd(model.todayCost)}${model.todayBudget === null ? '' : ` of ${usd(model.todayBudget)}`}`));
    }
    tail.append(
      textButton(model.halted ? 'Resume all' : 'Pause all', 'desk-btn', model.halted ? 'Let the chain dispatch again' : 'Let running work finish and start nothing new', () =>
        void deps.chainAction('chainMaster', { mode: model.halted ? 'run' : 'halted' }),
      ),
      textButton('Open Crew ›', 'desk-btn desk-btn-link', 'Open the Crew tab', openTeam),
    );
    root.replaceChildren(lead, people, tail);
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
